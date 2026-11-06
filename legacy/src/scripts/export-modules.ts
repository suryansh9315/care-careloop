/**
 * Export the condition modules' *data* to JSON for the Python port.
 *
 * The split matters. A ConditionModule is part data (items, bands, protocol
 * steps, prompts, medication orders) and part code (`riskRules`,
 * `crisisOverride`). Hand-transcribing ~600 lines of clinical data into Python
 * would introduce exactly the sort of silent, hard-to-spot error that the ACT
 * coding defect already is. So the data is machine-exported here, and only the
 * two closures are hand-ported.
 *
 * Fields deliberately dropped:
 *   moss                  — the retrieval layer is removed (Sarvam KB replaces it)
 *   researchTopicTemplate — enrichment is deferred, and it is a function
 *   riskRules             — hand-ported to Python
 *   crisisOverride        — hand-ported to Python
 *
 * Keys are converted to snake_case so the Python models read idiomatically.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { asthmaModule } from '../conditions/asthma.js';
import { depressionModule } from '../conditions/depression.js';
import type { ConditionModule } from '../conditions/types.js';

/**
 * ACT LOINC corrections — constraint C12.
 *
 * Every ACT code in asthma.ts is invalid: the check digits are wrong, AND the
 * item→code assignment is shifted one position because the panel's total-score
 * code was used as item 1's code. Each replacement below was verified against
 * the live terminology server via
 *   POST /api/v1/valueset/system-observation/validate_code/
 * and its display confirmed via the expand search. See docs/spike-results.md.
 *
 * PHQ-9's 11 codes were checked the same way and are correct, so depression
 * needs no corrections.
 */
const ACT_CODE_FIXES: Record<string, { to: string; display: string }> = {
  '82674-1': { to: '82674-3', display: 'Asthma Control Test [ACT] (panel)' },
  '82673-3': { to: '82668-5', display: 'Total score [ACT]' },
  '82668-3': { to: '82669-3', display: 'Activity limitation [ACT] — item 1' },
  '82669-1': { to: '82670-1', display: 'Shortness of breath [ACT] — item 2' },
  '82670-9': { to: '82671-9', display: 'Night-time waking [ACT] — item 3' },
  '82671-7': { to: '82672-7', display: 'Rescue inhaler use [ACT] — item 4' },
  '82672-5': { to: '82673-5', display: 'Self-rated control [ACT] — item 5' },
};

const applied: string[] = [];

function fixCode(code: string, where: string): string {
  const fix = ACT_CODE_FIXES[code];
  if (!fix) return code;
  applied.push(`${where}: ${code} -> ${fix.to}  (${fix.display})`);
  return fix.to;
}

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Recursively snake_case object keys. Arrays and scalars pass through. */
function deepSnake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSnake);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[snake(k)] = deepSnake(v);
    }
    return out;
  }
  return value;
}

function exportModule(module: ConditionModule) {
  const instrument = {
    id: module.instrument.id,
    name: module.instrument.name,
    loinc_panel_code: fixCode(module.instrument.loincPanelCode, `${module.id}.instrument.panel`),
    loinc_total_code: fixCode(module.instrument.loincTotalCode, `${module.id}.instrument.total`),
    min_total: module.instrument.minTotal,
    max_total: module.instrument.maxTotal,
    direction: module.instrument.direction,
    items: module.instrument.items.map((item) => ({
      link_id: item.linkId,
      loinc_code: fixCode(item.loincCode, `${module.id}.${item.linkId}`),
      prompt: item.prompt,
      min: item.min,
      max: item.max,
      scale_hint: item.scaleHint,
    })),
  };

  return {
    id: module.id,
    display: module.display,
    icd10: module.icd10,
    snomed: module.snomed,
    instrument,
    bands: module.bands.map((b) => ({ id: b.id, label: b.label, min: b.min, max: b.max })),
    risk_questions: module.riskQuestions.map((q) => ({
      link_id: q.linkId,
      prompt: q.prompt,
      expects: q.expects,
    })),
    steps: deepSnake(module.steps),
    emergency_rules: module.emergencyRules,
    crisis_band_id: module.crisisBandId ?? null,
    experts: module.experts.map((e) => ({
      id: e.id,
      name: e.name,
      specialty: e.specialty,
      safety_reviewer: e.safetyReviewer,
      system_prompt: e.systemPrompt,
    })),
  };
}

const OUT_DIR = resolve(process.cwd(), '../care_careloop/care_careloop/clinical/modules');

for (const module of [asthmaModule, depressionModule]) {
  const data = exportModule(module);
  const out = resolve(OUT_DIR, `${module.id}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(`wrote ${out}\n`);
}

process.stdout.write(`\nACT LOINC corrections applied (${applied.length}):\n`);
for (const line of applied) process.stdout.write(`  ${line}\n`);
if (applied.length !== Object.keys(ACT_CODE_FIXES).length) {
  process.stderr.write(
    `\nWARNING: ${Object.keys(ACT_CODE_FIXES).length} fixes defined but ${applied.length} applied — a code may have changed upstream.\n`,
  );
  process.exit(1);
}
