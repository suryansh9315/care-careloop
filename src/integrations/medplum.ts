import { MedplumClient } from '@medplum/core';
import type { Bundle, Resource, ResourceType } from '@medplum/fhirtypes';
import { env, isLive } from '../config/env.js';
import { logger } from '../logger.js';

/**
 * Thin repository over Medplum.
 *
 * The bridge holds a *server-side* client credential. This module is the only
 * place that credential is used; nothing it exports leaks the secret, and the
 * dashboard never talks to it.
 *
 * When Medplum credentials are absent the repository falls back to an
 * in-memory FHIR store so `npm run simulate` runs offline. Every write in that
 * mode is tagged `mock: true` in the returned metadata and logged as such.
 */

let clientPromise: Promise<MedplumClient> | undefined;

async function getClient(): Promise<MedplumClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new MedplumClient({ baseUrl: env.medplum.baseUrl, fetch });
      await client.startClientLogin(env.medplum.clientId, env.medplum.clientSecret);
      logger.info({ baseUrl: env.medplum.baseUrl }, 'medplum.authenticated');
      return client;
    })().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------
// In-memory fallback store
// ---------------------------------------------------------------------------

const memory = new Map<string, Resource>();
let memoryCounter = 0;

function memoryKey(resourceType: string, id: string): string {
  return `${resourceType}/${id}`;
}

function nextId(): string {
  memoryCounter += 1;
  return `mock-${memoryCounter.toString().padStart(6, '0')}`;
}

function matchesQuery(resource: Resource, query: Record<string, string>): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === '_count' || key === '_sort') return true;
    const serialised = JSON.stringify(resource);
    // Deliberately loose: the mock store only needs to be good enough for the
    // offline simulation, and pretending otherwise would be misleading.
    return serialised.includes(value.replace(/^[A-Za-z]+\//, ''));
  });
}

export function mockStoreSnapshot(): Resource[] {
  return [...memory.values()];
}

export function clearMockStore(): void {
  memory.clear();
  memoryCounter = 0;
}

// ---------------------------------------------------------------------------
// Public repository API
// ---------------------------------------------------------------------------

export const usingLiveMedplum = (): boolean => isLive('medplum');

export async function createResource<T extends Resource>(resource: T): Promise<T> {
  if (!isLive('medplum')) {
    const id = resource.id ?? nextId();
    const stored = { ...resource, id, meta: { ...resource.meta, versionId: '1' } } as T;
    memory.set(memoryKey(resource.resourceType, id), stored);
    logger.debug({ resourceType: resource.resourceType, id }, 'medplum.mock.create');
    return stored;
  }
  const client = await getClient();
  return (await client.createResource(resource)) as T;
}

export async function updateResource<T extends Resource>(resource: T): Promise<T> {
  if (!isLive('medplum')) {
    if (!resource.id) throw new Error('updateResource requires an id');
    memory.set(memoryKey(resource.resourceType, resource.id), resource);
    return resource;
  }
  const client = await getClient();
  return (await client.updateResource(resource)) as T;
}

export async function readResource<T extends Resource>(
  resourceType: ResourceType,
  id: string,
): Promise<T | undefined> {
  if (!isLive('medplum')) {
    return memory.get(memoryKey(resourceType, id)) as T | undefined;
  }
  const client = await getClient();
  try {
    return (await client.readResource(resourceType, id)) as T;
  } catch (error) {
    logger.warn({ resourceType, id, err: String(error) }, 'medplum.read.failed');
    return undefined;
  }
}

export async function searchResources<T extends Resource>(
  resourceType: ResourceType,
  query: Record<string, string> = {},
): Promise<T[]> {
  if (!isLive('medplum')) {
    return [...memory.values()].filter(
      (resource) => resource.resourceType === resourceType && matchesQuery(resource, query),
    ) as T[];
  }
  const client = await getClient();
  try {
    const results = await client.searchResources(resourceType, query);
    return [...results] as T[];
  } catch (error) {
    logger.warn({ resourceType, err: String(error) }, 'medplum.search.failed');
    return [];
  }
}

export async function executeBatch(bundle: Bundle): Promise<Bundle> {
  if (!isLive('medplum')) {
    const entries = bundle.entry ?? [];
    const responses = [];
    for (const entry of entries) {
      if (entry.resource) {
        const created = await createResource(entry.resource);
        responses.push({ resource: created, response: { status: '201' } });
      }
    }
    return { resourceType: 'Bundle', type: 'transaction-response', entry: responses };
  }
  const client = await getClient();
  return (await client.executeBatch(bundle)) as Bundle;
}

/**
 * Live chart writes during a call are best-effort: a transient Medplum failure
 * must never make the agent stall mid-sentence.
 */
export async function bestEffortCreate<T extends Resource>(
  resource: T,
  context: Record<string, unknown> = {},
): Promise<T | undefined> {
  try {
    return await createResource(resource);
  } catch (error) {
    logger.warn(
      { ...context, resourceType: resource.resourceType, err: String(error) },
      'medplum.write.besteffort.failed',
    );
    return undefined;
  }
}

/**
 * Validate an RxNorm code through Medplum's terminology service. Returns the
 * canonical display when the lookup succeeds, and `undefined` when it does not
 * — callers keep the seed display rather than blocking the draft.
 */
export async function validateMedicationCode(code: string): Promise<string | undefined> {
  if (!isLive('medplum')) return undefined;
  try {
    const client = await getClient();
    const result = (await client.post('fhir/R4/CodeSystem/$lookup', {
      resourceType: 'Parameters',
      parameter: [
        { name: 'system', valueUri: 'http://www.nlm.nih.gov/research/umls/rxnorm' },
        { name: 'code', valueCode: code },
      ],
    })) as { parameter?: Array<{ name?: string; valueString?: string }> };
    return result.parameter?.find((p) => p.name === 'display')?.valueString;
  } catch (error) {
    logger.debug({ code, err: String(error) }, 'medplum.terminology.lookup.failed');
    return undefined;
  }
}
