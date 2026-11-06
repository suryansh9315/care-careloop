import type { PlanDefinition } from '@medplum/fhirtypes';
import { z } from 'zod';
import { createResource, searchResources, updateResource } from '../integrations/medplum.js';
import { logger } from '../logger.js';
import type { ConditionModule } from './types.js';

/**
 * Treatments as data.
 *
 * A ConditionModule is the whole extension point for a new treatment, so it
 * must be authorable without a deploy. Modules are persisted as FHIR
 * PlanDefinitions — the resource FHIR already has for "a protocol you follow"
 * — with the module JSON carried in an extension, and hydrated into the
 * registry at startup.
 *
 * A module drives medication selection, so a malformed one is a clinical
 * hazard, not just a bad request. Everything read back from FHIR is validated
 * against the schema below before it is allowed near the registry; anything
 * that fails is logged and dropped rather than partially applied.
 */

export const MODULE_CANONICAL_BASE = 'https://careloop.dev/PlanDefinition';
const MODULE_EXTENSION_URL = 'https://careloop.dev/StructureDefinition/condition-module';

const medOrderSchema = z.object({
  display: z.string().min(1),
  rxnormCode: z.string().min(1),
  role: z.enum(['controller', 'reliever', 'primary', 'adjunct']),
  sig: z.string().min(1),
  route: z.string().min(1),
  frequency: z.string().min(1),
  prn: z.boolean(),
  durationDays: z.number().optional(),
  quantity: z.number().optional(),
  refills: z.number().optional(),
  ingredients: z.array(z.string()).optional(),
});

const stepSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  patientGoal: z.string().min(1),
  medications: z.array(medOrderSchema),
  followUpDays: z.number().int().positive(),
  referralRequired: z.boolean(),
  urgent: z.boolean(),
});

const instrumentItemSchema = z.object({
  linkId: z.string().min(1),
  loincCode: z.string().min(1),
  prompt: z.string().min(1),
  min: z.number().int(),
  max: z.number().int(),
  scaleHint: z.string(),
});

const bandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  min: z.number().int(),
  max: z.number().int(),
});

/**
 * The serialisable shape of a module. Functions (`riskRules`, `crisisOverride`,
 * `researchTopicTemplate`) cannot cross a FHIR resource, so a stored module is
 * data-only and inherits behaviour from its `extends` built-in when present.
 */
export const storedModuleSchema = z.object({
  id: z.string().min(1),
  display: z.string().min(1),
  icd10: z.string().min(1),
  snomed: z.string().min(1),
  extends: z.string().optional(),
  instrument: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    loincPanelCode: z.string().min(1),
    loincTotalCode: z.string().min(1),
    items: z.array(instrumentItemSchema).min(1),
    minTotal: z.number().int(),
    maxTotal: z.number().int(),
    direction: z.enum(['higher-is-better', 'higher-is-worse']),
  }),
  bands: z.array(bandSchema).min(1),
  riskQuestions: z.array(
    z.object({
      linkId: z.string().min(1),
      prompt: z.string().min(1),
      expects: z.enum(['yes-no', 'count', 'text']),
    }),
  ),
  steps: z.record(stepSchema),
  emergencyRules: z.array(z.string()).min(1),
  experts: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      specialty: z.string().min(1),
      safetyReviewer: z.boolean(),
      systemPrompt: z.string().min(1),
    }),
  ),
  moss: z.object({
    indexName: z.string().min(1),
    corpus: z.array(
      z.object({ id: z.string().min(1), text: z.string().min(1), source: z.string().min(1) }),
    ),
  }),
});

export type StoredModule = z.infer<typeof storedModuleSchema>;

/** Cross-field checks the shape schema cannot express. */
export function validateStoredModule(module: StoredModule): string[] {
  const problems: string[] = [];

  if (module.instrument.minTotal >= module.instrument.maxTotal) {
    problems.push('instrument.minTotal must be below maxTotal');
  }

  const sorted = [...module.bands].sort((a, b) => a.min - b.min);
  for (const [index, band] of sorted.entries()) {
    if (band.min > band.max) problems.push(`band "${band.id}" has min above max`);
    const next = sorted[index + 1];
    if (next && next.min !== band.max + 1) {
      problems.push(`bands "${band.id}" and "${next.id}" are not contiguous — a score can fall in no band`);
    }
  }
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  if (lowest && lowest.min !== module.instrument.minTotal) {
    problems.push('lowest band does not start at the instrument minimum');
  }
  if (highest && highest.max !== module.instrument.maxTotal) {
    problems.push('highest band does not end at the instrument maximum');
  }

  // Every band must have somewhere to go, or a real patient scores into a gap.
  for (const band of module.bands) {
    if (!module.steps[band.id]) problems.push(`band "${band.id}" has no protocol step`);
  }

  if (!module.experts.some((expert) => expert.safetyReviewer)) {
    problems.push('at least one expert must be the safety reviewer');
  }

  const linkIds = new Set<string>();
  for (const item of module.instrument.items) {
    if (linkIds.has(item.linkId)) problems.push(`duplicate item linkId "${item.linkId}"`);
    linkIds.add(item.linkId);
    if (item.min >= item.max) problems.push(`item "${item.linkId}" has min above max`);
  }

  return problems;
}

// ---------------------------------------------------------------- FHIR I/O

function toPlanDefinition(module: StoredModule): PlanDefinition {
  return {
    resourceType: 'PlanDefinition',
    status: 'active',
    url: `${MODULE_CANONICAL_BASE}/${module.id}`,
    name: module.id,
    title: module.display,
    type: { text: 'condition-module' },
    topic: [
      {
        coding: [
          { system: 'http://hl7.org/fhir/sid/icd-10', code: module.icd10, display: module.display },
          { system: 'http://snomed.info/sct', code: module.snomed, display: module.display },
        ],
        text: module.display,
      },
    ],
    extension: [{ url: MODULE_EXTENSION_URL, valueString: JSON.stringify(module) }],
  };
}

function fromPlanDefinition(definition: PlanDefinition): StoredModule | undefined {
  const raw = definition.extension?.find((e) => e.url === MODULE_EXTENSION_URL)?.valueString;
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ id: definition.id, name: definition.name }, 'conditions.store.unparseable');
    return undefined;
  }

  const result = storedModuleSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { name: definition.name, issues: result.error.issues.slice(0, 5) },
      'conditions.store.invalid-shape',
    );
    return undefined;
  }

  const problems = validateStoredModule(result.data);
  if (problems.length > 0) {
    logger.warn({ name: definition.name, problems }, 'conditions.store.invalid-clinical');
    return undefined;
  }

  return result.data;
}

/** Upsert on the canonical URL so re-publishing a module never duplicates it. */
export async function saveModule(module: StoredModule): Promise<PlanDefinition> {
  const url = `${MODULE_CANONICAL_BASE}/${module.id}`;
  const existing = await searchResources<PlanDefinition>('PlanDefinition', { url, _count: '1' });
  const definition = toPlanDefinition(module);

  if (existing[0]?.id) {
    const saved = await updateResource<PlanDefinition>({ ...definition, id: existing[0].id });
    logger.info({ module: module.id }, 'conditions.store.updated');
    return saved;
  }

  const saved = await createResource(definition);
  logger.info({ module: module.id }, 'conditions.store.created');
  return saved;
}

export async function loadStoredModules(): Promise<StoredModule[]> {
  try {
    const definitions = await searchResources<PlanDefinition>('PlanDefinition', {
      status: 'active',
      _count: '100',
    });
    const modules = definitions
      .map(fromPlanDefinition)
      .filter((module): module is StoredModule => Boolean(module));
    logger.info(
      { found: definitions.length, valid: modules.length },
      'conditions.store.loaded',
    );
    return modules;
  } catch (error) {
    // A store failure must never stop the bridge booting — the built-in
    // modules are always available.
    logger.warn({ err: String(error) }, 'conditions.store.load.failed');
    return [];
  }
}

/**
 * Turn a stored (data-only) module into a runnable one by borrowing behaviour
 * from a built-in. Without a behavioural base a stored module still runs: it
 * simply contributes no risk findings and uses a generic research topic.
 */
export function toRuntimeModule(
  stored: StoredModule,
  base: ConditionModule | undefined,
): ConditionModule {
  return {
    id: stored.id,
    display: stored.display,
    icd10: stored.icd10,
    snomed: stored.snomed,
    instrument: stored.instrument,
    bands: stored.bands,
    riskQuestions: stored.riskQuestions,
    steps: stored.steps,
    emergencyRules: stored.emergencyRules,
    experts: stored.experts,
    moss: stored.moss,
    crisisOverride: base?.crisisOverride,
    crisisBandId: base?.crisisBandId,
    riskRules: base?.riskRules ?? (() => []),
    researchTopicTemplate:
      base?.researchTopicTemplate ??
      (({ conditionDisplay, band, total }) =>
        `Evidence-based management of ${conditionDisplay} with a total of ${total} (${band}).`),
  };
}

/**
 * Serialise a runtime module for storage. The behavioural functions are not
 * serialisable, so `extends` records which built-in to borrow them back from
 * when the module is hydrated.
 */
export function toStoredModule(module: ConditionModule): StoredModule {
  return {
    id: module.id,
    display: module.display,
    icd10: module.icd10,
    snomed: module.snomed,
    extends: module.id,
    instrument: {
      id: module.instrument.id,
      name: module.instrument.name,
      loincPanelCode: module.instrument.loincPanelCode,
      loincTotalCode: module.instrument.loincTotalCode,
      items: module.instrument.items.map((item) => ({ ...item })),
      minTotal: module.instrument.minTotal,
      maxTotal: module.instrument.maxTotal,
      direction: module.instrument.direction,
    },
    bands: module.bands.map((band) => ({ ...band })),
    riskQuestions: module.riskQuestions.map((question) => ({ ...question })),
    steps: Object.fromEntries(
      Object.entries(module.steps).map(([key, step]) => [
        key,
        { ...step, medications: step.medications.map((med) => ({ ...med })) },
      ]),
    ),
    emergencyRules: [...module.emergencyRules],
    experts: module.experts.map((expert) => ({ ...expert })),
    moss: {
      indexName: module.moss.indexName,
      corpus: module.moss.corpus.map((entry) => ({ ...entry })),
    },
  };
}

export { MODULE_EXTENSION_URL };
