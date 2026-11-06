/**
 * Pushes each condition module's corpus to its own Moss index.
 *
 * Routing a question through the patient's resolved condition module means a
 * depression question can never be answered from the asthma corpus, so the
 * indexes are kept separate on purpose.
 *
 *   npm run moss:index            # every module
 *   npm run moss:index asthma     # one module
 */

import './quiet.js';
import { listModules, tryGetModule } from '../conditions/registry.js';
import { indexCorpus } from '../integrations/moss.js';

async function main(): Promise<void> {
  const requested = process.argv[2];
  const modules = requested
    ? [tryGetModule(requested)].filter((m): m is NonNullable<typeof m> => Boolean(m))
    : listModules();

  if (modules.length === 0) {
    console.error(`Unknown module "${requested}".`);
    process.exit(1);
  }

  for (const module of modules) {
    const outcome = await indexCorpus(module.moss);
    const label = outcome === 'skipped' ? 'SKIPPED (no Moss credentials)' : outcome;
    console.log(`${module.moss.indexName.padEnd(28)} ${String(module.moss.corpus.length).padStart(3)} docs — ${label}`);
  }

  console.log('\nReminder: this corpus is patient-safe education only. Never index');
  console.log('patient identifiers, transcripts, or clinical history.\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
