/**
 * Instrument scale definitions shared by every clinical chart.
 *
 * Ground truth is the condition modules on the server (src/conditions/*.ts) —
 * do not invent numbers here. If the clinical bands change, change them there
 * first and mirror the change into this file.
 */

export type BandTone = 'green' | 'amber' | 'red' | 'gray';

export interface BandRegion {
  id: string;
  label: string;
  /** inclusive */
  min: number;
  /** inclusive */
  max: number;
  tone: BandTone;
}

export interface ScaleSpec {
  /** short instrument code, e.g. 'ACT' */
  instrument: string;
  instrumentLong: string;
  min: number;
  max: number;
  higherIsBetter: boolean;
  /** the clinically meaningful cut point */
  target: number;
  /** minimal clinically important difference — the smallest change that matters */
  mcid: number;
  /** ascending by min, contiguous, covering min..max */
  bands: BandRegion[];
}

const ASTHMA_SCALE: ScaleSpec = {
  instrument: 'ACT',
  instrumentLong: 'Asthma Control Test',
  min: 5,
  max: 25,
  higherIsBetter: true,
  target: 20,
  mcid: 3,
  bands: [
    { id: 'poor', label: 'very poorly controlled', min: 5, max: 15, tone: 'red' },
    { id: 'partial', label: 'not well controlled', min: 16, max: 19, tone: 'amber' },
    { id: 'well', label: 'well controlled', min: 20, max: 25, tone: 'green' },
  ],
};

const DEPRESSION_SCALE: ScaleSpec = {
  instrument: 'PHQ-9',
  instrumentLong: 'Patient Health Questionnaire-9',
  min: 0,
  max: 27,
  higherIsBetter: false,
  target: 5,
  mcid: 5,
  bands: [
    { id: 'minimal', label: 'minimal', min: 0, max: 4, tone: 'green' },
    { id: 'mild', label: 'mild', min: 5, max: 9, tone: 'green' },
    { id: 'moderate', label: 'moderate', min: 10, max: 14, tone: 'amber' },
    { id: 'moderately-severe', label: 'moderately severe', min: 15, max: 19, tone: 'red' },
    { id: 'severe', label: 'severe', min: 20, max: 27, tone: 'red' },
  ],
};

const FALLBACK_SCALE: ScaleSpec = {
  instrument: 'Score',
  instrumentLong: 'Score',
  min: 0,
  max: 25,
  higherIsBetter: true,
  target: 20,
  mcid: 3,
  bands: [{ id: 'unknown', label: 'score', min: 0, max: 25, tone: 'gray' }],
};

const SCALES: Record<string, ScaleSpec> = { asthma: ASTHMA_SCALE, depression: DEPRESSION_SCALE };

export function scaleForModule(moduleId: string | undefined): ScaleSpec {
  return (moduleId && SCALES[moduleId]) || FALLBACK_SCALE;
}

/**
 * Infer the instrument from a plan title or condition text, since a FHIR
 * CarePlan does not carry the module id. Falls back to the generic scale.
 */
export function scaleForText(text: string | undefined): ScaleSpec {
  const lower = (text ?? '').toLowerCase();
  if (lower.includes('phq') || lower.includes('depress')) return DEPRESSION_SCALE;
  if (lower.includes('act') || lower.includes('asthma')) return ASTHMA_SCALE;
  return FALLBACK_SCALE;
}

/** The band containing `total`, clamping out-of-range scores to the nearest edge band. */
export function bandForScore(scale: ScaleSpec, total: number): BandRegion {
  const clamped = Math.max(scale.min, Math.min(scale.max, total));
  for (const band of scale.bands) {
    if (clamped >= band.min && clamped <= band.max) return band;
  }
  return clamped <= scale.bands[0]!.min ? scale.bands[0]! : scale.bands[scale.bands.length - 1]!;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Maps a clinical band tone onto the app's validated status palette. */
export function toneVars(tone: BandTone): { bg: string; ink: string } {
  switch (tone) {
    case 'green':
      return { bg: 'var(--ok-bg)', ink: 'var(--ok)' };
    case 'amber':
      return { bg: 'var(--urgent-bg)', ink: 'var(--urgent)' };
    case 'red':
      return { bg: 'var(--critical-bg)', ink: 'var(--critical)' };
    default:
      return { bg: 'var(--surface-3)', ink: 'var(--muted)' };
  }
}

/** Solid mark colour for a band tone (bars, meters, series). */
export function toneMark(tone: BandTone): string {
  switch (tone) {
    case 'green':
      return 'var(--ok)';
    case 'amber':
      return 'var(--urgent-mark)';
    case 'red':
      return 'var(--critical)';
    default:
      return 'var(--line-2)';
  }
}
