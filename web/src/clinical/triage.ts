/**
 * Triage: the queue's job is ranking, not listing.
 *
 * Every plan is scored into a clinical urgency level with the concrete reasons
 * a clinician would care about, plus a single sortable `rank` (lower = more
 * urgent). Keeping this pure makes the ordering testable and identical
 * everywhere the queue is shown.
 */
import { bandForScore, type ScaleSpec } from './scale';

export type TriageLevel = 'critical' | 'urgent' | 'routine';
export interface TriageReason { code: string; label: string }
export interface Triage { level: TriageLevel; reasons: TriageReason[]; rank: number }

export interface TriageInput {
  /** ISO timestamp the plan was drafted. */
  created?: string;
  safetyCritical: number;
  safetyWarning: number;
  /** 'revise' | 'approve-with-notes' | 'approve-as-drafted' | undefined */
  consensus?: string;
  scale: ScaleSpec;
  scoreTotal?: number;
  /** prior totals, oldest → newest, excluding today's. */
  priorScores: number[];
  priorAuthRequired?: boolean;
  covered?: boolean;
}

const LEVEL_TIER: Record<TriageLevel, number> = { critical: 0, urgent: 1, routine: 2 };
const TIER_SCALE = 1_000_000;
const SEVERITY_SCALE = 100;
const SEVERITY_CAP = 999;

export function triage(input: TriageInput): Triage {
  const reasons: TriageReason[] = [];
  let level: TriageLevel = 'routine';
  let severity = 0;

  // Raises level/severity only when the new level is at least as urgent as the
  // current one — a later, milder match records its reason but must never
  // soften an already-critical rank.
  const escalate = (next: TriageLevel, magnitude: number): void => {
    if (LEVEL_TIER[next] < LEVEL_TIER[level]) {
      level = next;
      severity = magnitude;
    } else if (LEVEL_TIER[next] === LEVEL_TIER[level]) {
      severity = Math.max(severity, magnitude);
    }
  };

  if (input.safetyCritical > 0) {
    reasons.push({
      code: 'safety-critical',
      label: `${input.safetyCritical} critical safety flag${input.safetyCritical === 1 ? '' : 's'}`,
    });
    escalate('critical', input.safetyCritical);
  }

  if (input.consensus === 'revise') {
    reasons.push({ code: 'peer-revise', label: 'Expert panel asked for revision' });
    escalate('urgent', 4);
  }

  if (input.scoreTotal != null) {
    const band = bandForScore(input.scale, input.scoreTotal);
    if (band.tone === 'red') {
      reasons.push({ code: 'score-red-band', label: band.label });
      const distance = input.scale.higherIsBetter
        ? input.scale.target - input.scoreTotal
        : input.scoreTotal - input.scale.target;
      escalate('urgent', Math.max(0, distance));
    } else if (band.tone === 'amber') {
      // An intermediate band is a live clinical finding: it must outrank
      // routine paperwork, so it leads the routine tier rather than sorting
      // below a controlled patient whose only flag is a prior-auth.
      reasons.push({ code: 'score-amber-band', label: band.label });
      escalate('routine', 3);
    }
  }

  if (input.scoreTotal != null && input.priorScores.length > 0) {
    const previous = input.priorScores[input.priorScores.length - 1]!;
    const delta = input.scoreTotal - previous;
    // Direction-aware: for ACT (higher is better) a drop is a decline; for
    // PHQ-9 (higher is worse) a rise is.
    const worsened = input.scale.higherIsBetter ? delta < 0 : delta > 0;
    const magnitude = Math.abs(delta);
    if (worsened && magnitude >= input.scale.mcid) {
      reasons.push({
        code: 'trend-worsened',
        label: `Worsened ${magnitude} point${magnitude === 1 ? '' : 's'} since last check-in`,
      });
      escalate('urgent', magnitude);
    }
  }

  if (input.safetyWarning > 0 && level === 'routine') {
    reasons.push({
      code: 'safety-warning',
      label: `${input.safetyWarning} safety warning${input.safetyWarning === 1 ? '' : 's'}`,
    });
    escalate('routine', 3);
  }

  if (input.priorAuthRequired || input.covered === false) {
    reasons.push({ code: 'coverage', label: 'Coverage needs attention' });
    escalate('routine', 2);
  }

  const tier = LEVEL_TIER[level];
  const severityBucket = SEVERITY_CAP - Math.min(SEVERITY_CAP, Math.max(0, Math.round(severity)));
  // Oldest-first tiebreak, scaled so it only ever breaks ties inside the same
  // level+severity bucket and never crosses a bucket boundary.
  const ageMillis = Date.parse(input.created ?? '');
  const ageComponent = Number.isNaN(ageMillis) ? 0 : ageMillis * 1e-13;

  return { level, reasons, rank: tier * TIER_SCALE + severityBucket * SEVERITY_SCALE + ageComponent };
}
