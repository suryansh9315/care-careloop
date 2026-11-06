/**
 * Per-item metadata for the shipped instruments.
 *
 * This is what lets the review surfaces answer "*which questions* drove this
 * score?" rather than only showing the total. The linkIds mirror the server's
 * condition modules (src/conditions/asthma.ts, depression.ts) — keep them in
 * sync; a mismatch silently drops items from the breakdown.
 */

export interface ItemMeta {
  linkId: string;
  /** Short label for dense layouts. */
  short: string;
  prompt: string;
  /** What the endpoints mean, low → high. */
  scale: string;
  min: number;
  max: number;
  /** A worst-end response triggers its own protocol regardless of the total. */
  sentinel?: boolean;
}

export interface InstrumentMeta {
  label: string;
  longLabel: string;
  /** True when a HIGHER per-item response is the better outcome (ACT). */
  higherIsBetter: boolean;
  items: ItemMeta[];
}

const ACT: InstrumentMeta = {
  label: 'ACT',
  longLabel: 'Asthma Control Test',
  higherIsBetter: true,
  items: [
    {
      linkId: 'act-1',
      short: 'Activity limitation',
      prompt:
        'In the past 4 weeks, how much of the time did your asthma keep you from getting as much done at work, school or at home?',
      scale: '1 = all of the time … 5 = none of the time',
      min: 1,
      max: 5,
    },
    {
      linkId: 'act-2',
      short: 'Shortness of breath',
      prompt: 'During the past 4 weeks, how often have you had shortness of breath?',
      scale: '1 = more than once a day … 5 = not at all',
      min: 1,
      max: 5,
    },
    {
      linkId: 'act-3',
      short: 'Night-time waking',
      prompt:
        'During the past 4 weeks, how often did your asthma symptoms wake you up at night or earlier than usual in the morning?',
      scale: '1 = four or more nights a week … 5 = not at all',
      min: 1,
      max: 5,
    },
    {
      linkId: 'act-4',
      short: 'Rescue inhaler use',
      prompt: 'During the past 4 weeks, how often have you used your rescue inhaler or nebulizer medication?',
      scale: '1 = three or more times per day … 5 = not at all',
      min: 1,
      max: 5,
    },
    {
      linkId: 'act-5',
      short: 'Self-rated control',
      prompt: 'How would you rate your asthma control during the past 4 weeks?',
      scale: '1 = not controlled at all … 5 = completely controlled',
      min: 1,
      max: 5,
    },
  ],
};

const PHQ9_SCALE = '0 = not at all … 3 = nearly every day';

const PHQ9: InstrumentMeta = {
  label: 'PHQ-9',
  longLabel: 'Patient Health Questionnaire-9',
  higherIsBetter: false,
  items: (
    [
      ['phq9-1', 'Interest / pleasure', 'Little interest or pleasure in doing things'],
      ['phq9-2', 'Depressed mood', 'Feeling down, depressed, or hopeless'],
      ['phq9-3', 'Sleep', 'Trouble falling or staying asleep, or sleeping too much'],
      ['phq9-4', 'Energy', 'Feeling tired or having little energy'],
      ['phq9-5', 'Appetite', 'Poor appetite or overeating'],
      ['phq9-6', 'Self-worth', 'Feeling bad about yourself, or that you are a failure'],
      ['phq9-7', 'Concentration', 'Trouble concentrating on things'],
      ['phq9-8', 'Psychomotor', 'Moving or speaking noticeably slowly, or being restless'],
      ['phq9-9', 'Self-harm thoughts', 'Thoughts that you would be better off dead, or of hurting yourself'],
    ] as const
  ).map(([linkId, short, stem]) => ({
    linkId,
    short,
    prompt: `Over the last 2 weeks, how often have you been bothered by: ${stem}?`,
    scale: PHQ9_SCALE,
    min: 0,
    max: 3,
    ...(linkId === 'phq9-9' ? { sentinel: true as const } : {}),
  })),
};

/** LOINC code → ACT item, so Observations can be mapped back to their question. */
const LOINC_TO_LINK: Record<string, string> = {
  '82668-3': 'act-1',
  '82669-1': 'act-2',
  '82670-9': 'act-3',
  '82671-7': 'act-4',
  '82672-5': 'act-5',
};

const BY_INSTRUMENT: Record<string, InstrumentMeta> = { ACT, 'PHQ-9': PHQ9 };

export function instrumentMeta(instrument: string | undefined): InstrumentMeta | null {
  return (instrument && BY_INSTRUMENT[instrument]) || null;
}

export function linkIdForLoinc(code: string | undefined): string | undefined {
  return code ? LOINC_TO_LINK[code] : undefined;
}

/**
 * How bad one response is, normalised to 0 (best) … 1 (worst), so items on
 * different scales and directions share one severity ramp.
 */
export function itemSeverity(item: ItemMeta, value: number, higherIsBetter: boolean): number {
  const span = item.max - item.min;
  if (span <= 0) return 0;
  const clamped = Math.max(item.min, Math.min(item.max, value));
  const fraction = (clamped - item.min) / span;
  return higherIsBetter ? 1 - fraction : fraction;
}
