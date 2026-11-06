/**
 * Freeze the behaviour of the deterministic clinical core.
 *
 * Phase 2 of the CARE revamp ports this core from TypeScript to Python inside
 * the `care_careloop` plugin. A port is only trustworthy if it is *provably*
 * behaviour-preserving, so this writes every input/output pair of the pure
 * functions to `golden/core-golden.json`. The Python port then asserts it
 * reproduces that file exactly.
 *
 * Every case construction here is deliberately simple and order-dependent
 * (greedy fill, fixed literal vectors) so it can be re-implemented in Python
 * without ambiguity. Nothing random, nothing clock-dependent.
 *
 * Deliberately NOT covered: the LOINC/SNOMED codes. Codes do not affect
 * scoring, so this file cannot detect the ACT coding defect recorded as C12 in
 * docs/REVAMP-PLAN.md. That fix is manual and must be verified separately.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { asthmaModule } from '../conditions/asthma.js';
import { depressionModule } from '../conditions/depression.js';
import { completeness, scoreInstrument, stepForBand } from '../orchestration/scoring.js';
import { isAffirmative, parseCount } from '../orchestration/numbers.js';
import {
  checkRegimenSafety,
  evaluateRisk,
  hasCritical,
  shouldEscalate,
} from '../orchestration/safety.js';
import type { ConditionModule } from '../conditions/types.js';
import type { InstrumentAnswer, MedOrder, RiskAnswer } from '../types.js';

const MODULES: ConditionModule[] = [asthmaModule, depressionModule];

/**
 * Canonical answer vector summing to `total`: start every item at its minimum,
 * then fill items in declaration order up to their maximum. Deterministic, and
 * portable to Python line for line.
 */
function answersForTotal(module: ConditionModule, total: number): InstrumentAnswer[] {
  const items = module.instrument.items;
  const answers = items.map((i) => ({ linkId: i.linkId, value: i.min }));
  let remaining = total - items.reduce((sum, i) => sum + i.min, 0);
  for (let idx = 0; idx < answers.length && remaining > 0; idx += 1) {
    const room = items[idx]!.max - items[idx]!.min;
    const give = Math.min(room, remaining);
    answers[idx]!.value = items[idx]!.min + give;
    remaining -= give;
  }
  return answers;
}

function scoreCase(module: ConditionModule, answers: InstrumentAnswer[]) {
  const score = scoreInstrument(module, answers);
  let step: unknown;
  let stepError: string | null = null;
  try {
    step = stepForBand(module, score.band);
  } catch (error) {
    stepError = String(error instanceof Error ? error.message : error);
  }
  return {
    answers,
    score,
    completeness: completeness(module, answers),
    step: step ? JSON.parse(JSON.stringify(step)) : null,
    stepError,
  };
}

// ---------------------------------------------------------------------------
// 1. Band sweep — every achievable total, both instruments
// ---------------------------------------------------------------------------

const bandSweep: Record<string, unknown[]> = {};
for (const module of MODULES) {
  const rows: unknown[] = [];
  for (let total = module.instrument.minTotal; total <= module.instrument.maxTotal; total += 1) {
    rows.push({ requestedTotal: total, ...scoreCase(module, answersForTotal(module, total)) });
  }
  bandSweep[module.id] = rows;
}

// ---------------------------------------------------------------------------
// 2. Malformed input — clamping, missing items, unknown link ids
// ---------------------------------------------------------------------------

/** Values a voice pipeline can realistically produce when it goes wrong. */
const MALFORMED_VALUES = [-100, -1, 0, 0.4, 2.5, 2.6, 99, 1e9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const malformed: Record<string, unknown[]> = {};
for (const module of MODULES) {
  const rows: unknown[] = [];
  const first = module.instrument.items[0]!;

  // Every malformed value, applied to every item at once.
  for (const value of MALFORMED_VALUES) {
    rows.push({
      label: `all-items=${String(value)}`,
      ...scoreCase(
        module,
        module.instrument.items.map((i) => ({ linkId: i.linkId, value })),
      ),
    });
  }
  // Partial completion: first N items only.
  for (let n = 0; n <= module.instrument.items.length; n += 1) {
    rows.push({
      label: `first-${n}-items-at-max`,
      ...scoreCase(
        module,
        module.instrument.items.slice(0, n).map((i) => ({ linkId: i.linkId, value: i.max })),
      ),
    });
  }
  // Unknown link ids must be ignored, not counted.
  rows.push({
    label: 'unknown-link-ids-only',
    ...scoreCase(module, [
      { linkId: 'not-a-real-item', value: 3 },
      { linkId: '', value: 3 },
    ]),
  });
  // Duplicate answers for the same item: last write wins via the Map.
  rows.push({
    label: 'duplicate-answers-same-item',
    ...scoreCase(module, [
      { linkId: first.linkId, value: first.min },
      { linkId: first.linkId, value: first.max },
    ]),
  });
  malformed[module.id] = rows;
}

// ---------------------------------------------------------------------------
// 3. Crisis override — the safety-critical path
// ---------------------------------------------------------------------------

const crisis: Record<string, unknown[]> = {};
for (const module of MODULES) {
  if (!module.crisisOverride) continue;
  const rows: unknown[] = [];
  const items = module.instrument.items;
  const last = items[items.length - 1]!;
  for (const baseTotal of [module.instrument.minTotal, 5, 10, 20, module.instrument.maxTotal]) {
    if (baseTotal < module.instrument.minTotal || baseTotal > module.instrument.maxTotal) continue;
    for (let crisisValue = last.min; crisisValue <= last.max; crisisValue += 1) {
      const answers = answersForTotal(module, baseTotal).map((a) =>
        a.linkId === last.linkId ? { ...a, value: crisisValue } : a,
      );
      rows.push({
        label: `baseTotal=${baseTotal} ${last.linkId}=${crisisValue}`,
        ...scoreCase(module, answers),
      });
    }
  }
  crisis[module.id] = rows;
}

// ---------------------------------------------------------------------------
// 4. Risk rules
// ---------------------------------------------------------------------------

/** Answer sets covering yes/no, counts and refusals for every risk question. */
const RISK_VALUES = ['yes', 'no', 'Yes', 'NO', '', 'maybe', '0', '1', '3', '12', 'about four', 'I would rather not say'];

const risk: Record<string, unknown[]> = {};
for (const module of MODULES) {
  const rows: unknown[] = [];
  const questions = module.riskQuestions;
  for (const value of RISK_VALUES) {
    const riskAnswers: RiskAnswer[] = questions.map((q) => ({ linkId: q.linkId, value }));
    for (const total of [module.instrument.minTotal, module.instrument.maxTotal]) {
      const score = scoreInstrument(module, answersForTotal(module, total));
      const findings = evaluateRisk(module, riskAnswers, score);
      rows.push({
        label: `all-risk="${value}" total=${total}`,
        riskAnswers,
        score,
        findings,
        hasCritical: hasCritical(findings),
      });
    }
  }
  // One question at a time, to isolate each rule.
  for (const question of questions) {
    for (const value of ['yes', 'no', '12']) {
      const riskAnswers: RiskAnswer[] = [{ linkId: question.linkId, value }];
      const score = scoreInstrument(
        module,
        answersForTotal(module, module.instrument.maxTotal),
      );
      const findings = evaluateRisk(module, riskAnswers, score);
      rows.push({
        label: `only ${question.linkId}="${value}"`,
        riskAnswers,
        score,
        findings,
        hasCritical: hasCritical(findings),
      });
    }
  }
  // Empty risk answers must not throw.
  const emptyScore = scoreInstrument(module, answersForTotal(module, module.instrument.minTotal));
  rows.push({
    label: 'no-risk-answers',
    riskAnswers: [],
    score: emptyScore,
    findings: evaluateRisk(module, [], emptyScore),
    hasCritical: false,
  });
  risk[module.id] = rows;
}

// ---------------------------------------------------------------------------
// 5. Safety screen — allergy, duplicate therapy, interaction
// ---------------------------------------------------------------------------

function allRegimens(module: ConditionModule): Array<{ band: string; regimen: MedOrder[] }> {
  return module.bands.map((band) => ({
    band: band.id,
    regimen: module.steps[band.id]?.medications ?? [],
  }));
}

/** Contexts derived from the module's own regimens, so this stays data-driven. */
function safetyContexts(module: ConditionModule) {
  const meds = allRegimens(module).flatMap((r) => r.regimen);
  const first = meds[0];
  const firstIngredient = first?.ingredients?.[0] ?? first?.display?.split(' ')[0]?.toLowerCase() ?? 'none';
  return [
    { label: 'empty', allergies: [] as string[], currentMedications: [] },
    {
      label: 'allergy-to-first-ingredient',
      allergies: [firstIngredient],
      currentMedications: [],
    },
    {
      label: 'allergy-uppercase',
      allergies: [firstIngredient.toUpperCase()],
      currentMedications: [],
    },
    {
      label: 'allergy-unrelated',
      allergies: ['penicillin'],
      currentMedications: [],
    },
    {
      label: 'duplicate-therapy',
      allergies: [],
      currentMedications: first
        ? [{ display: first.display, rxnormCode: first.rxnormCode, ingredients: first.ingredients }]
        : [],
    },
    {
      label: 'on-propranolol',
      allergies: [],
      currentMedications: [{ display: 'Propranolol 40 mg tablet', ingredients: ['propranolol'] }],
    },
    {
      label: 'allergy-and-duplicate-and-interaction',
      allergies: [firstIngredient],
      currentMedications: [
        ...(first ? [{ display: first.display, ingredients: first.ingredients }] : []),
        { display: 'Propranolol 40 mg tablet', ingredients: ['propranolol'] },
      ],
    },
  ];
}

const safety: Record<string, unknown[]> = {};
for (const module of MODULES) {
  const rows: unknown[] = [];
  for (const { band, regimen } of allRegimens(module)) {
    for (const context of safetyContexts(module)) {
      const findings = checkRegimenSafety(regimen, {
        allergies: context.allergies,
        currentMedications: context.currentMedications,
      });
      rows.push({
        label: `band=${band} context=${context.label}`,
        // Full MedOrders, not just displays: a golden file has to carry
        // complete inputs, or the port has to guess how they were built.
        regimen: JSON.parse(JSON.stringify(regimen)),
        context: { allergies: context.allergies, currentMedications: context.currentMedications },
        findings,
        hasCritical: hasCritical(findings),
      });
    }
  }
  safety[module.id] = rows;
}

// ---------------------------------------------------------------------------
// 6. Escalation truth table
// ---------------------------------------------------------------------------

const SEVERITIES = ['info', 'warning', 'critical'] as const;
const escalation: unknown[] = [];
for (const urgentStep of [false, true]) {
  for (const safetySeverity of [null, ...SEVERITIES]) {
    for (const riskSeverity of [null, ...SEVERITIES]) {
      const input = {
        urgentStep,
        safety: safetySeverity
          ? [{ severity: safetySeverity as never, code: 'note' as const, message: 'x' }]
          : [],
        risks: riskSeverity
          ? [{ severity: riskSeverity as never, code: 'x', message: 'x' }]
          : [],
      };
      escalation.push({
        urgentStep,
        safetySeverity,
        riskSeverity,
        escalate: shouldEscalate(input),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Spoken-number parsing — the "about four canisters" corpus
// ---------------------------------------------------------------------------

const COUNT_CORPUS = [
  '', ' ', 'none', 'zero', 'no', 'nope', 'never',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'twenty', 'a couple', 'a few', 'once', 'twice', 'thrice',
  '0', '1', '4', '12', '100',
  'about four canisters', 'roughly 4', 'around three times', 'maybe two or three',
  'four or five', 'i think about four', 'four canisters', 'FOUR', 'Four.',
  'more than ten', 'at least 3', 'every month', 'all the time',
  'i do not know', "i can't remember", 'not sure',
  'one hundred and twelve', 'minus two', '-2', '3.5', 'three and a half',
  'twenty four seven', 'a dozen', 'half a canister',
];

const AFFIRMATIVE_CORPUS = [
  '', 'yes', 'Yes', 'YES', 'yeah', 'yep', 'yup', 'sure', 'of course', 'definitely',
  'correct', 'that is right', 'mm hmm', 'uh huh', 'aye', 'absolutely', 'i have',
  'no', 'No', 'nope', 'never', 'not really', 'i do not think so', 'negative',
  'maybe', 'sometimes', 'i am not sure', 'no comment',
  'no, yes', 'yes, no', 'not yes', 'yes but only once',
];

const numbers = {
  parseCount: COUNT_CORPUS.map((text) => ({ text, result: parseCount(text) ?? null })),
  isAffirmative: AFFIRMATIVE_CORPUS.map((text) => ({ text, result: isAffirmative(text) })),
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const golden = {
  $schema: 'careloop-core-golden/1',
  description:
    'Frozen behaviour of the deterministic clinical core. The Python port in care_careloop must reproduce this exactly. Codes (LOINC/SNOMED) are NOT covered — see C12 in docs/REVAMP-PLAN.md.',
  generatedFrom: 'src/orchestration/{scoring,safety,numbers}.ts + src/conditions/{asthma,depression}.ts',
  modules: MODULES.map((m) => ({
    id: m.id,
    instrument: m.instrument.id,
    direction: m.instrument.direction,
    minTotal: m.instrument.minTotal,
    maxTotal: m.instrument.maxTotal,
    items: m.instrument.items.map((i) => ({ linkId: i.linkId, min: i.min, max: i.max })),
    bands: m.bands,
    riskQuestions: m.riskQuestions.map((q) => ({ linkId: q.linkId, expects: q.expects })),
  })),
  cases: { bandSweep, malformed, crisis, risk, safety, escalation, numbers },
};

/**
 * JSON cannot represent NaN or +/-Infinity -- `JSON.stringify` writes `null` for
 * all three. That would be a silent fidelity hole: the frozen *inputs* for the
 * non-finite malformed cases would read back as `null`, so the Python port
 * would replay a different input than the one that was frozen. Tag them
 * instead, and have the port decode the tags back to real float values.
 */
function tagNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    if (Number.isNaN(value)) return '@NaN';
    return value > 0 ? '@Infinity' : '@-Infinity';
  }
  return value;
}

// Lives inside the plugin package: it is the fixture that guards the Python
// core, the plugin ships self-contained, and the backend container mounts only
// the plugin directory.
const out = resolve(
  process.cwd(),
  '../care_careloop/care_careloop/clinical/tests/data/core-golden.json',
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(golden, tagNonFinite, 2)}\n`);

const counts = {
  bandSweep: Object.values(bandSweep).reduce((n, r) => n + r.length, 0),
  malformed: Object.values(malformed).reduce((n, r) => n + r.length, 0),
  crisis: Object.values(crisis).reduce((n, r) => n + r.length, 0),
  risk: Object.values(risk).reduce((n, r) => n + r.length, 0),
  safety: Object.values(safety).reduce((n, r) => n + r.length, 0),
  escalation: escalation.length,
  parseCount: numbers.parseCount.length,
  isAffirmative: numbers.isAffirmative.length,
};
const total = Object.values(counts).reduce((a, b) => a + b, 0);
process.stdout.write(`${out}\n`);
for (const [k, v] of Object.entries(counts)) process.stdout.write(`  ${k.padEnd(14)} ${v}\n`);
process.stdout.write(`  ${'TOTAL'.padEnd(14)} ${total} frozen cases\n`);
