import type { ConditionModule } from '../conditions/types.js';
import { complete, parseJsonObject } from '../integrations/llm.js';
import { getMossClient } from '../integrations/moss.js';
import { logger } from '../logger.js';
import type {
  Citation,
  Concern,
  PatientContext,
  ProtocolStep,
  ResearchFinding,
  ScoreResult,
} from '../types.js';

/**
 * Off-call evidence synthesis attached to a draft plan.
 *
 * This never diagnoses, prescribes, or activates anything. It answers two
 * questions for the reviewing clinician: why this band implies this step, and
 * what to consider about each concern the patient actually raised.
 *
 * "Deep" here means breadth of topic, not autonomy: one phenotype topic plus
 * one topic per patient concern, each grounded in the condition corpus.
 */

const SYSTEM_PROMPT = `You are a clinical evidence assistant preparing decision support for a licensed clinician who will review a draft care plan.

Rules:
- Do not invent patient facts. Use only what is provided.
- Do not state a diagnosis or a specific dose as a recommendation.
- Write for a clinician: concise, specific, no filler.
- The rationale must be 2-4 sentences.
- Return exactly one JSON object and nothing else:
  {"rationale": "...", "citations": [{"title": "...", "source": "...", "url": "..."}]}
- Provide two or three citations to well-known public clinical guidance.`;

/** Used whenever the model is unavailable, times out, or returns nothing usable. */
function fallbackCitations(module: ConditionModule): Citation[] {
  if (module.id === 'depression') {
    return [
      { title: 'Depression in adults: treatment and management (NG222)', source: 'NICE', url: 'https://www.nice.org.uk/guidance/ng222' },
      { title: 'Practice Guideline for the Treatment of Patients With Major Depressive Disorder', source: 'American Psychiatric Association' },
    ];
  }
  return [
    { title: 'Global Strategy for Asthma Management and Prevention', source: 'GINA', url: 'https://ginasthma.org/reports/' },
    { title: 'Asthma: diagnosis, monitoring and chronic asthma management (NG245)', source: 'NICE', url: 'https://www.nice.org.uk/guidance/ng245' },
  ];
}

function fallbackRationale(score: ScoreResult, step: ProtocolStep): string {
  return (
    'Evidence synthesis did not run for this topic, so this is the deterministic protocol rationale only. ' +
    `A total of ${score.total} placed this patient in the "${score.bandLabel}" band, which maps to protocol step "${step.id}": ${step.summary} ` +
    'The citations below are generic references and have not been matched to this patient.'
  );
}

async function researchTopic(input: {
  module: ConditionModule;
  topic: string;
  context: PatientContext;
  score: ScoreResult;
  step: ProtocolStep;
}): Promise<ResearchFinding> {
  const { module, topic, context, score, step } = input;

  // Best-effort retrieval: a Moss failure must not stop the synthesis.
  let snippets: Array<{ text: string; source: string }> = [];
  try {
    snippets = await getMossClient(module.moss).retrieve(topic, { k: 4 });
  } catch (error) {
    logger.warn({ topic, err: String(error) }, 'research.retrieval.failed');
  }

  const clinicKnowledge = snippets
    .map((s, index) => `[${index + 1}] (${s.source}) ${s.text}`)
    .join('\n\n');

  const userPrompt = [
    `Condition: ${context.conditionDisplay ?? module.display}`,
    `Instrument: ${module.instrument.name}, total ${score.total} (${score.bandLabel})${score.crisisOverride ? ' — CRISIS OVERRIDE ACTIVE' : ''}`,
    `Drafted protocol step: ${step.id} — ${step.summary}`,
    `Drafted regimen: ${step.medications.map((m) => `${m.display} (${m.sig})`).join('; ') || 'none'}`,
    `Current medications: ${context.currentMedications.map((m) => m.display).join('; ') || 'none recorded'}`,
    `Allergies: ${context.allergies.join('; ') || 'none recorded'}`,
    `Triggers: ${context.triggers.join('; ') || 'none recorded'}`,
    `Prior totals (oldest first): ${context.priorScores.map((s) => s.total).join(', ') || 'none'}`,
    '',
    'Clinic knowledge context:',
    clinicKnowledge || '(no snippets retrieved)',
    '',
    `Research topic: ${topic}`,
  ].join('\n');

  const result = await complete({ system: SYSTEM_PROMPT, user: userPrompt, maxTokens: 700 });
  const parsed = parseJsonObject<{ rationale?: string; citations?: Citation[] }>(result.text);

  if (!result.live || !parsed?.rationale) {
    return {
      topic,
      rationale: fallbackRationale(score, step),
      citations: fallbackCitations(module),
      grounded: false,
    };
  }

  const citations =
    Array.isArray(parsed.citations) && parsed.citations.length > 0
      ? parsed.citations.slice(0, 3).map((c) => ({
          title: String(c.title ?? 'Untitled'),
          source: String(c.source ?? 'Unattributed'),
          url: c.url ? String(c.url) : undefined,
        }))
      : fallbackCitations(module);

  return { topic, rationale: parsed.rationale.trim(), citations, grounded: snippets.length > 0 };
}

export async function researchPlan(input: {
  module: ConditionModule;
  context: PatientContext;
  score: ScoreResult;
  step: ProtocolStep;
  concerns: Concern[];
}): Promise<ResearchFinding[]> {
  const { module, context, score, step, concerns } = input;

  const phenotypeTopic = module.researchTopicTemplate({
    conditionDisplay: context.conditionDisplay ?? module.display,
    band: score.bandLabel,
    total: score.total,
    triggers: context.triggers,
  });

  const topics = [
    phenotypeTopic,
    ...concerns.slice(0, 5).map((concern) => `Patient-raised concern: ${concern.text}`),
  ];

  // Topics are independent, so they run in parallel; a rejection in one must
  // not lose the others.
  const settled = await Promise.allSettled(
    topics.map((topic) => researchTopic({ module, topic, context, score, step })),
  );

  return settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    const topic = topics[index] ?? 'unknown topic';
    logger.warn({ topic, err: String(outcome.reason) }, 'research.topic.failed');
    return {
      topic,
      rationale: fallbackRationale(score, step),
      citations: fallbackCitations(module),
      grounded: false,
    };
  });
}
