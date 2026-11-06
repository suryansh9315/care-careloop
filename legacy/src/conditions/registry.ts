import { logger } from '../logger.js';
import { asthmaModule } from './asthma.js';
import { depressionModule } from './depression.js';
import { loadStoredModules, toRuntimeModule } from './store.js';
import type { ConditionModule } from './types.js';

const BUILT_IN: ConditionModule[] = [asthmaModule, depressionModule];

export function builtInModule(id: string | undefined): ConditionModule | undefined {
  return BUILT_IN.find((module) => module.id === id);
}

const registry = new Map<string, ConditionModule>();

function reset(): void {
  registry.clear();
  for (const module of BUILT_IN) registry.set(module.id, module);
}

reset();

/**
 * Hydrate stored modules first, then overlay the built-in seed modules so a
 * broken stored definition can never shadow a known-good one.
 */
export function hydrateModules(stored: ConditionModule[]): void {
  registry.clear();
  for (const module of stored) {
    registry.set(module.id, module);
  }
  for (const module of BUILT_IN) {
    registry.set(module.id, module);
  }
  logger.info(
    { stored: stored.length, builtIn: BUILT_IN.length, total: registry.size },
    'conditions.hydrated',
  );
}

/**
 * Pull stored modules from FHIR and rebuild the registry.
 *
 * Called at startup and again whenever a treatment is edited, so an authoring
 * change takes effect without a restart. Built-ins are overlaid last, which is
 * what makes the reload safe: a stored module that has been broken by an edit
 * cannot shadow a known-good built-in mid-demo.
 */
export async function reloadFromStore(): Promise<{ stored: number; total: number }> {
  const stored = await loadStoredModules();
  const runtime = stored.map((module) =>
    toRuntimeModule(module, builtInModule(module.extends ?? module.id)),
  );
  hydrateModules(runtime);
  return { stored: runtime.length, total: registry.size };
}

export function getModule(moduleId: string): ConditionModule {
  const module = registry.get(moduleId);
  if (!module) {
    throw new Error(`Unknown condition module: ${moduleId}`);
  }
  return module;
}

export function tryGetModule(moduleId: string | undefined): ConditionModule | undefined {
  return moduleId ? registry.get(moduleId) : undefined;
}

export function listModules(): ConditionModule[] {
  return [...registry.values()];
}

/** Resolve a module from a coded condition, falling back to the module id. */
export function moduleForCondition(input: {
  moduleId?: string;
  icd10?: string;
  snomed?: string;
}): ConditionModule | undefined {
  if (input.moduleId && registry.has(input.moduleId)) return registry.get(input.moduleId);
  for (const module of registry.values()) {
    if (input.icd10 && module.icd10 === input.icd10) return module;
    if (input.snomed && module.snomed === input.snomed) return module;
  }
  return undefined;
}

export { asthmaModule, depressionModule };
export type { ConditionModule };
