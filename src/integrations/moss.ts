import { env, isLive } from '../config/env.js';
import { logger } from '../logger.js';
import type { MossCorpusEntry } from '../conditions/types.js';
import type { RetrievalSnippet } from '../types.js';

/**
 * Moss is the retrieval layer for patient-*safe* condition knowledge only.
 *
 * It must never receive patient identifiers, transcripts, coverage details or
 * clinical history. Those live in Medplum and are passed directly to the
 * orchestration layer instead. The only things sent to Moss are the question
 * text and the static condition corpus.
 */

export interface MossClient {
  retrieve(question: string, options?: { k?: number }): Promise<RetrievalSnippet[]>;
}

interface MossIndexConfig {
  indexName: string;
  corpus: MossCorpusEntry[];
}

/** Minimal structural view of the bits of `@moss-dev/moss` we depend on. */
interface MossSdkClient {
  createIndex(indexName: string, docs: MossDoc[], options?: unknown): Promise<unknown>;
  addDocs(indexName: string, docs: MossDoc[], options?: { upsert?: boolean }): Promise<unknown>;
  getIndex(indexName: string): Promise<{ name: string; docCount?: number }>;
  loadIndex(indexName: string, options?: unknown): Promise<string>;
  query(
    indexName: string,
    query: string,
    options?: { topK?: number },
  ): Promise<{ docs?: Array<{ id: string; text: string; score: number; metadata?: Record<string, string> }> }>;
}

interface MossDoc {
  id: string;
  text: string;
  metadata?: Record<string, string>;
}

const clients = new Map<string, MossClient>();

// ---------------------------------------------------------------------------
// Deterministic keyword scorer (mock mode)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'my', 'i', 'do',
  'does', 'what', 'how', 'why', 'when', 'should', 'can', 'for', 'on', 'with',
  'are', 'be', 'about', 'me', 'you', 'this', 'that', 'if',
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function keywordScore(question: string, entry: MossCorpusEntry): number {
  const questionTokens = tokenise(question);
  if (questionTokens.length === 0) return 0;
  const entryTokens = new Set(tokenise(`${entry.id} ${entry.text}`));
  let hits = 0;
  for (const token of questionTokens) {
    if (entryTokens.has(token)) hits += 1;
  }
  return hits / questionTokens.length;
}

function mockClient(config: MossIndexConfig): MossClient {
  return {
    async retrieve(question, options) {
      const k = options?.k ?? 1;
      const ranked = config.corpus
        .map((entry) => ({ entry, score: keywordScore(question, entry) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

      // A zero-scoring corpus still returns its first entry rather than
      // nothing, so the agent always has something safe to say.
      const selected = ranked.some((r) => r.score > 0) ? ranked : ranked.slice(0, 1);

      return selected.map(({ entry, score }) => ({
        text: entry.text,
        source: entry.source,
        score,
        mock: true,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Live client (@moss-dev/moss, lazily imported)
// ---------------------------------------------------------------------------

/**
 * The Moss SDK ships a native binding. Importing it eagerly would make the
 * whole bridge fail to boot on a platform where the binding cannot load, so
 * the import happens on first use and any failure degrades to mock retrieval.
 */
async function loadMossSdk(): Promise<{ MossClient: new (id: string, key: string) => MossSdkClient } | undefined> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<any>;
    const sdk = await dynamicImport('@moss-dev/moss');
    if (!sdk?.MossClient) {
      logger.warn('moss.sdk.missing-client-export');
      return undefined;
    }
    return sdk;
  } catch (error) {
    logger.warn({ err: String(error) }, 'moss.sdk.unavailable');
    return undefined;
  }
}

export async function createSdkClient(): Promise<MossSdkClient | undefined> {
  const sdk = await loadMossSdk();
  if (!sdk) return undefined;
  return new sdk.MossClient(env.moss.projectId, env.moss.projectKey);
}

function liveClient(config: MossIndexConfig): MossClient {
  let ready: Promise<MossSdkClient | undefined> | undefined;
  const fallback = mockClient(config);

  async function ensureIndex(): Promise<MossSdkClient | undefined> {
    if (!ready) {
      ready = (async () => {
        const client = await createSdkClient();
        if (!client) return undefined;
        // Loading pulls the index into memory so each query is local rather
        // than a cloud round-trip on the live call path.
        await client.loadIndex(config.indexName);
        logger.info({ index: config.indexName }, 'moss.index.loaded');
        return client;
      })().catch((error) => {
        logger.warn({ index: config.indexName, err: String(error) }, 'moss.index.load.failed');
        return undefined;
      });
    }
    return ready;
  }

  return {
    async retrieve(question, options) {
      const k = options?.k ?? 1;
      const client = await ensureIndex();
      if (!client) return fallback.retrieve(question, options);
      try {
        const response = await client.query(config.indexName, question, { topK: k });
        const rows = response?.docs ?? [];
        if (rows.length === 0) {
          logger.warn({ index: config.indexName }, 'moss.live.empty');
          return fallback.retrieve(question, options);
        }
        return rows.slice(0, k).map((row) => ({
          text: String(row.text ?? ''),
          source: String(row.metadata?.source ?? config.indexName),
          score: Number(row.score ?? 0),
          mock: false,
        }));
      } catch (error) {
        logger.warn({ index: config.indexName, err: String(error) }, 'moss.live.fallback');
        return fallback.retrieve(question, options);
      }
    },
  };
}

export function getMossClient(config: MossIndexConfig): MossClient {
  const cached = clients.get(config.indexName);
  if (cached) return cached;
  const client = isLive('moss') ? liveClient(config) : mockClient(config);
  if (!isLive('moss')) {
    logger.debug({ index: config.indexName }, 'moss.mock.enabled');
  }
  clients.set(config.indexName, client);
  return client;
}

/**
 * Used by `npm run moss:index`. Creating an index that already exists throws,
 * so an existing index is updated in place with an upsert instead.
 */
export async function indexCorpus(config: MossIndexConfig): Promise<'created' | 'updated' | 'skipped'> {
  if (!isLive('moss')) {
    logger.warn({ index: config.indexName }, 'moss.index.skipped.no-credentials');
    return 'skipped';
  }
  const client = await createSdkClient();
  if (!client) return 'skipped';

  const docs: MossDoc[] = config.corpus.map((entry) => ({
    id: entry.id,
    text: entry.text,
    metadata: { source: entry.source },
  }));

  let exists = false;
  try {
    await client.getIndex(config.indexName);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    await client.addDocs(config.indexName, docs, { upsert: true });
    logger.info({ index: config.indexName, documents: docs.length }, 'moss.index.updated');
    return 'updated';
  }

  await client.createIndex(config.indexName, docs);
  logger.info({ index: config.indexName, documents: docs.length }, 'moss.index.created');
  return 'created';
}
