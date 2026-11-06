/**
 * Seeds one demo patient into Medplum and prints the identifiers to paste into
 * `.env`. Requires live Medplum credentials; without them it writes to the
 * in-memory store and says so.
 *
 *   npm run seed -- --module asthma --phone +15555550123
 */

import { live } from '../config/env.js';
import { getModule, listModules } from '../conditions/registry.js';
import { saveModule, toStoredModule, validateStoredModule } from '../conditions/store.js';
import { createIntake } from '../orchestration/intake.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

async function main(): Promise<void> {
  const moduleId = arg('module', 'asthma');
  try {
    getModule(moduleId);
  } catch {
    console.error(`Unknown module "${moduleId}". Available: ${listModules().map((m) => m.id).join(', ')}`);
    process.exit(1);
  }

  if (!live.medplum) {
    console.warn(
      '\n⚠  MEDPLUM_CLIENT_ID / MEDPLUM_CLIENT_SECRET are not set.\n' +
        '   Seeding into the in-memory store instead — the ids below will not persist.\n',
    );
  }

  const result = await createIntake({
    moduleId,
    givenName: arg('given', 'Jane'),
    familyName: arg('family', 'Doe'),
    birthDate: arg('dob', '1985-03-14'),
    phone: arg('phone', '+15555550123'),
    coverage: {
      payerId: arg('payer', '87726'),
      payerName: arg('payer-name', 'Test Payer'),
      memberId: arg('member', 'MEMBER123'),
    },
    allergies: arg('allergies', 'penicillin').split(',').filter(Boolean),
    triggers: arg('triggers', 'house dust mite,cold air').split(',').filter(Boolean),
  });

  // Publish the built-in modules as PlanDefinitions so the registry has
  // something to hydrate and the Treatments admin has something to edit.
  for (const module of listModules()) {
    const stored = toStoredModule(module);
    const problems = validateStoredModule(stored);
    if (problems.length > 0) {
      console.warn(`  ! ${module.id} failed validation: ${problems.join('; ')}`);
      continue;
    }
    await saveModule(stored);
    console.log(`  published PlanDefinition for ${module.id}`);
  }

  console.log('\nSeeded. Add these to your .env:\n');
  console.log(`SEED_PATIENT_ID=${result.patientId}`);
  console.log(`SEED_CONDITION_ID=${result.conditionId}`);
  console.log(`SEED_QUESTIONNAIRE_ID=${result.questionnaireId}`);
  console.log(`\nAnd for the dashboard (web/.env):\n`);
  console.log(`VITE_PATIENT_ID=${result.patientId}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
