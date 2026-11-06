/**
 * Repoints seeded patients at a different phone number.
 *
 * Twilio trial accounts only reach verified numbers, and a demo often has to
 * move to whichever handset is in the room. Editing each Patient by hand is
 * error-prone at exactly the wrong moment.
 *
 *   npm run update-phones -- +13215550123            # dry run
 *   npm run update-phones -- +13215550123 --apply
 *   npm run update-phones -- +13215550123 --patient <id> --apply
 */

import './quiet.js';
import type { Patient } from '@medplum/fhirtypes';
import { live } from '../config/env.js';
import { readResource, searchResources, updateResource } from '../integrations/medplum.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

const APPLY = process.argv.includes('--apply');

function patientName(patient: Patient): string {
  const name = patient.name?.[0];
  if (!name) return '(unnamed)';
  return [name.given?.join(' '), name.family].filter(Boolean).join(' ') || name.text || '(unnamed)';
}

function withPhone(patient: Patient, phone: string): Patient {
  const telecom = (patient.telecom ?? []).filter((entry) => entry.system !== 'phone');
  return { ...patient, telecom: [...telecom, { system: 'phone', value: phone, use: 'mobile' }] };
}

async function main(): Promise<void> {
  const phone = process.argv[2];
  if (!phone || !phone.startsWith('+')) {
    console.error('Pass a phone number in E.164 form, e.g. npm run update-phones -- +13215550123');
    process.exit(1);
  }
  if (!live.medplum) {
    console.error('Medplum credentials are required — this script writes to a real FHIR server.');
    process.exit(1);
  }

  const only = arg('patient');
  const patients = only
    ? [await readResource<Patient>('Patient', only)].filter((p): p is Patient => Boolean(p))
    : await searchResources<Patient>('Patient', { _count: '100' });

  if (patients.length === 0) {
    console.log('No patients matched.');
    return;
  }

  console.log(`\nRepointing ${patients.length} patient(s) to ${phone}`);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: DRY RUN — pass --apply to write\n');

  for (const patient of patients) {
    const current = patient.telecom?.find((t) => t.system === 'phone')?.value ?? '(none)';
    console.log(`  ${patientName(patient).padEnd(24)} ${current.padEnd(18)} → ${phone}`);
    if (APPLY) {
      await updateResource(withPhone(patient, phone));
    }
  }

  console.log(
    APPLY
      ? `\nUpdated ${patients.length} patient(s).\n`
      : '\nRe-run with --apply to write.\n',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
