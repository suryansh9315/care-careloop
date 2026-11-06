import type { ConditionModule } from '../conditions/types.js';
import type { InstrumentAnswer, ProtocolStep, ScoreResult } from '../types.js';

/**
 * Scoring and protocol selection are deliberately deterministic. The language
 * model never chooses the band or the medication: given the same answers, this
 * function returns the same plan, and that is what makes the core inspectable.
 */

export function scoreInstrument(
  module: ConditionModule,
  answers: InstrumentAnswer[],
): ScoreResult {
  const byLinkId = new Map(answers.map((a) => [a.linkId, a.value]));

  let total = 0;
  for (const item of module.instrument.items) {
    const raw = byLinkId.get(item.linkId);
    if (raw === undefined) continue;
    total += clamp(raw, item.min, item.max);
  }
  total = clamp(total, module.instrument.minTotal, module.instrument.maxTotal);

  const crisisOverride = module.crisisOverride?.(answers) ?? false;
  if (crisisOverride && module.crisisBandId) {
    return {
      total,
      band: module.crisisBandId,
      bandLabel: 'Crisis pathway',
      crisisOverride: true,
    };
  }

  const band = module.bands.find((b) => total >= b.min && total <= b.max);
  if (!band) {
    // Should be unreachable given the clamp, but a missing band must not throw
    // mid-pipeline: fall back to the most cautious band the module defines.
    const fallback = mostCautiousBand(module);
    return { total, band: fallback.id, bandLabel: fallback.label, crisisOverride: false };
  }

  return { total, band: band.id, bandLabel: band.label, crisisOverride: false };
}

export function stepForBand(module: ConditionModule, bandId: string): ProtocolStep {
  const step = module.steps[bandId];
  if (step) return step;
  const fallback = mostCautiousBand(module);
  const fallbackStep = module.steps[fallback.id];
  if (!fallbackStep) {
    throw new Error(`Module ${module.id} defines no protocol step for band ${bandId}`);
  }
  return fallbackStep;
}

/**
 * The band a module should fall back to when banding fails: worst severity, so
 * an unexpected input escalates to a clinician rather than under-treating.
 */
function mostCautiousBand(module: ConditionModule): { id: string; label: string } {
  const bands = [...module.bands];
  bands.sort((a, b) =>
    module.instrument.direction === 'higher-is-worse' ? b.max - a.max : a.min - b.min,
  );
  const band = bands[0];
  if (!band) throw new Error(`Module ${module.id} defines no bands`);
  return { id: band.id, label: band.label };
}

/** Answered items only, so a partial call is visibly partial. */
export function completeness(module: ConditionModule, answers: InstrumentAnswer[]): {
  answered: number;
  total: number;
  complete: boolean;
} {
  const linkIds = new Set(module.instrument.items.map((i) => i.linkId));
  const answered = new Set(answers.filter((a) => linkIds.has(a.linkId)).map((a) => a.linkId)).size;
  return { answered, total: linkIds.size, complete: answered === linkIds.size };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
