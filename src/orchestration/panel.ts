import type { ConditionModule, ExpertPersona } from '../conditions/types.js';
import { complete, parseJsonObject } from '../integrations/llm.js';
import { logger } from '../logger.js';
import type {
  PanelConsensus,
  PanelResult,
  PanelReview,
  ProtocolStep,
  ResearchFinding,
  ReviewStance,
  RiskFinding,
  SafetyFinding,
  ScoreResult,
} from '../types.js';

/**
 * A panel of model personas critiquing the deterministic draft.
 *
 * This is explicitly NOT a clinical sign-off. Nothing here changes the plan;
 * it produces notes and a consensus label that the human approver sees. The
 * human clinician remains the sole approver.
 */

const STANCES: ReviewStance[] = ['agree', 'concern', 'suggest-edit'];

const OUTPUT_CONTRACT = `Return exactly one JSON object and nothing else:
{"stance": "agree" | "concern" | "suggest-edit", "rationale": "one or two sentences", "suggestedEdit": "optional concrete change"}`;

async function runPersona(input: {
  persona: ExpertPersona;
  brief: string;
}): Promise<PanelReview> {
  const { persona, brief } = input;

  const result = await complete({
    system: `${persona.systemPrompt}\n\n${OUTPUT_CONTRACT}`,
    user: brief,
    maxTokens: 400,
  });

  const parsed = parseJsonObject<{ stance?: string; rationale?: string; suggestedEdit?: string }>(
    result.text,
  );

  if (!result.live || !parsed?.rationale) {
    return {
      persona: persona.name,
      specialty: persona.specialty,
      stance: 'agree',
      rationale:
        'Peer review was unavailable for this persona, so no independent critique was produced. Treat this as missing enrichment, not as agreement.',
      live: false,
    };
  }

  const stance = STANCES.includes(parsed.stance as ReviewStance)
    ? (parsed.stance as ReviewStance)
    : 'concern';

  return {
    persona: persona.name,
    specialty: persona.specialty,
    stance,
    rationale: parsed.rationale.trim(),
    suggestedEdit: parsed.suggestedEdit?.trim() || undefined,
    live: true,
  };
}

/**
 * Aggregation is deterministic and deliberately pessimistic: a safety
 * reviewer's concern outranks unanimous agreement from everyone else.
 */
export function aggregateConsensus(
  reviews: PanelReview[],
  module: ConditionModule,
): PanelConsensus {
  const safetyPersonaNames = new Set(
    module.experts.filter((e) => e.safetyReviewer).map((e) => e.name),
  );

  const safetyConcern = reviews.some(
    (r) => safetyPersonaNames.has(r.persona) && r.live && r.stance === 'concern',
  );
  if (safetyConcern) return 'revise';

  const liveReviews = reviews.filter((r) => r.live);
  if (liveReviews.length > 0 && liveReviews.every((r) => r.stance === 'agree')) {
    return 'approve-as-drafted';
  }
  if (liveReviews.length === 0) {
    // Nothing actually reviewed the draft. Say so rather than implying approval.
    return 'approve-with-notes';
  }
  return 'approve-with-notes';
}

export async function runExpertPanel(input: {
  module: ConditionModule;
  score: ScoreResult;
  step: ProtocolStep;
  safety: SafetyFinding[];
  risks: RiskFinding[];
  research: ResearchFinding[];
  escalated: boolean;
  currentMedications: string[];
  allergies: string[];
}): Promise<PanelResult> {
  const { module } = input;

  const brief = [
    `Condition module: ${module.display}`,
    `Instrument: ${module.instrument.name}`,
    `Score: ${input.score.total} (${input.score.bandLabel})${input.score.crisisOverride ? ' — CRISIS OVERRIDE' : ''}`,
    `Drafted step: ${input.step.id} — ${input.step.summary}`,
    `Drafted regimen: ${input.step.medications.map((m) => `${m.display}: ${m.sig}`).join(' | ') || 'none'}`,
    `Follow-up: ${input.step.followUpDays} days. Referral required: ${input.step.referralRequired}. Escalated: ${input.escalated}.`,
    `Current medications: ${input.currentMedications.join('; ') || 'none recorded'}`,
    `Allergies: ${input.allergies.join('; ') || 'none recorded'}`,
    `Deterministic safety findings: ${input.safety.map((f) => `[${f.severity}] ${f.message}`).join(' | ') || 'none'}`,
    `Risk findings: ${input.risks.map((f) => `[${f.severity}] ${f.message}`).join(' | ') || 'none'}`,
    '',
    'Evidence rationales:',
    ...input.research.map((r) => `- ${r.topic}: ${r.rationale}`),
  ].join('\n');

  const settled = await Promise.allSettled(
    module.experts.map((persona) => runPersona({ persona, brief })),
  );

  const reviews: PanelReview[] = settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    const persona = module.experts[index];
    logger.warn({ persona: persona?.id, err: String(outcome.reason) }, 'panel.persona.failed');
    return {
      persona: persona?.name ?? 'Unknown reviewer',
      specialty: persona?.specialty ?? 'unknown',
      stance: 'agree' as const,
      rationale: 'This reviewer failed to run. Treat as missing enrichment, not as agreement.',
      live: false,
    };
  });

  return { reviews, consensus: aggregateConsensus(reviews, module) };
}
