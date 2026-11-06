/**
 * Live integration check.
 *
 * Talks to every configured external system and reports what actually works,
 * so "it ran" is never confused with "it was real". Read-only wherever the
 * provider allows it: no call is placed, no patient is created.
 *
 *   npm run doctor
 *   npm run doctor -- --patient <id>   # also verify one patient's live context
 */

import './quiet.js';
import type { Basic } from '@medplum/fhirtypes';
import WebSocket from 'ws';
import { env, live } from '../config/env.js';
import { asthmaModule } from '../conditions/asthma.js';
import { listModules } from '../conditions/registry.js';
import { complete } from '../integrations/llm.js';
import { createSdkClient, getMossClient } from '../integrations/moss.js';
import { checkEligibility } from '../integrations/stedi.js';

type Status = 'ok' | 'mock' | 'fail';

interface Check {
  service: string;
  status: Status;
  detail: string;
}

const results: Check[] = [];

function record(service: string, status: Status, detail: string): void {
  results.push({ service, status, detail });
  const icon = status === 'ok' ? '\x1b[32m✓\x1b[0m' : status === 'mock' ? '\x1b[33m○\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${icon} ${service.padEnd(22)} ${detail}`);
}

async function checkMedplum(): Promise<void> {
  if (!live.medplum) {
    record('Medplum', 'mock', 'no client credentials — in-memory store');
    return;
  }
  try {
    const { MedplumClient } = await import('@medplum/core');
    const client = new MedplumClient({ baseUrl: env.medplum.baseUrl, fetch });
    await client.startClientLogin(env.medplum.clientId, env.medplum.clientSecret);

    const patients = await client.searchResources('Patient', { _count: '1' });
    const plans = await client.searchResources('CarePlan', { _count: '1', status: 'draft' });
    record(
      'Medplum',
      'ok',
      `authenticated · ${patients.length ? 'patient read ok' : 'no patients yet'} · draft plans readable (${plans.length})`,
    );

    // Write path: create and immediately delete a throwaway resource.
    const probe = await client.createResource<Basic>({
      resourceType: 'Basic',
      code: { text: 'careloop-doctor-probe' },
    });
    if (probe.id) {
      await client.deleteResource('Basic', probe.id);
      record('Medplum write', 'ok', 'create + delete round-trip succeeded');
    }
  } catch (error) {
    record('Medplum', 'fail', String(error).slice(0, 160));
  }
}

async function checkMoss(): Promise<void> {
  if (!live.moss) {
    record('Moss', 'mock', 'no project credentials — keyword scorer');
    return;
  }
  const client = await createSdkClient();
  if (!client) {
    record('Moss', 'fail', 'SDK failed to load (native binding?) — falls back to keyword scorer');
    return;
  }

  for (const module of listModules()) {
    const indexName = module.moss.indexName;
    try {
      const info = await client.getIndex(indexName);
      record(`Moss index ${module.id}`, 'ok', `${indexName} exists (${info.docCount ?? '?'} docs)`);
    } catch {
      record(`Moss index ${module.id}`, 'fail', `${indexName} does not exist — run: npm run moss:index`);
    }
  }

  // Retrieval through the same path the live call uses.
  try {
    const snippets = await getMossClient(asthmaModule.moss).retrieve(
      'how do I use my inhaler properly',
      { k: 1 },
    );
    const top = snippets[0];
    if (!top) {
      record('Moss retrieval', 'fail', 'no snippet returned');
    } else if (top.mock) {
      record('Moss retrieval', 'mock', 'fell back to the local corpus — live query did not work');
    } else {
      record('Moss retrieval', 'ok', `score ${top.score.toFixed(3)} from "${top.source}"`);
    }
  } catch (error) {
    record('Moss retrieval', 'fail', String(error).slice(0, 160));
  }
}

async function checkStedi(): Promise<void> {
  if (!live.stedi) {
    const missing = [
      !env.stedi.apiKey && 'STEDI_API_KEY',
      !env.stedi.payerId && 'STEDI_PAYER_ID',
      !env.stedi.providerNpi && 'STEDI_PROVIDER_NPI',
    ].filter(Boolean);
    record('Stedi', 'mock', `missing ${missing.join(', ')} — deterministic mock`);
    return;
  }

  const result = await checkEligibility({
    payerId: env.stedi.payerId,
    memberId: process.env.STEDI_SUB_MEMBER_ID ?? '',
    subscriberFirstName: process.env.STEDI_SUB_FIRST_NAME,
    subscriberLastName: process.env.STEDI_SUB_LAST_NAME,
    subscriberDob: process.env.STEDI_SUB_DOB,
  });

  if (result.mock) {
    record('Stedi', 'mock', 'request did not return a usable 271 — see the warning above');
  } else {
    record(
      'Stedi',
      'ok',
      `live 271 · covered=${result.covered} · copay=${result.copayUsd ?? 'n/a'} · priorAuth=${result.priorAuthRequired}`,
    );
  }
}

async function checkLlm(): Promise<void> {
  if (!live.llm) {
    record('LLM', 'mock', `provider "${env.llm.provider}" not configured — deterministic fallbacks`);
    return;
  }
  const result = await complete({
    system: 'Reply with exactly one JSON object and nothing else.',
    user: 'Return {"ok": true}',
    maxTokens: 32,
  });
  if (!result.live) {
    record('LLM', 'fail', `${env.llm.provider} returned nothing — research and panel will fall back`);
    return;
  }
  const model = env.llm.provider === 'anthropic' ? env.llm.anthropicModel : env.llm.groqModel;
  record('LLM', 'ok', `${env.llm.provider} · ${model} · replied ${result.text.trim().slice(0, 40)}`);
}

async function checkTwilio(): Promise<void> {
  if (!live.twilio) {
    record('Twilio', 'mock', 'no credentials — calls are simulated');
    return;
  }
  try {
    const twilio = (await import('twilio')).default;
    const client = twilio(env.twilio.accountSid, env.twilio.authToken);
    const account = await client.api.accounts(env.twilio.accountSid).fetch();

    const numbers = await client.incomingPhoneNumbers.list({ limit: 20 });
    const owned = numbers.some((n) => n.phoneNumber === env.twilio.phoneNumber);
    record(
      'Twilio',
      account.status === 'active' ? 'ok' : 'fail',
      `account ${account.status} (${account.type}) · ${env.twilio.phoneNumber} ${owned ? 'owned' : 'NOT found on this account'}`,
    );

    if (account.type === 'Trial') {
      record(
        'Twilio trial limits',
        'mock',
        'trial account: outbound calls only reach verified numbers, and play a trial notice first',
      );
    }
  } catch (error) {
    record('Twilio', 'fail', String(error).slice(0, 160));
  }
}

async function checkDeepgram(): Promise<void> {
  if (!live.deepgram) {
    record('Deepgram', 'mock', 'no API key — no voice agent socket');
    return;
  }

  // Verify the key against the REST API first: a bad key on the agent socket
  // surfaces as an opaque close, which is much harder to read.
  try {
    const response = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${env.deepgram.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      record('Deepgram key', 'fail', `projects API returned ${response.status}`);
      return;
    }
    const body = (await response.json()) as { projects?: Array<{ name?: string }> };
    record('Deepgram key', 'ok', `valid · ${body.projects?.length ?? 0} project(s)`);
  } catch (error) {
    record('Deepgram key', 'fail', String(error).slice(0, 160));
    return;
  }

  // Then open the real agent socket and send the real Settings payload.
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(env.deepgram.agentUrl, ['token', env.deepgram.apiKey]);
    const timer = setTimeout(() => {
      record('Deepgram agent', 'fail', 'no SettingsApplied within 15s');
      socket.close();
      resolve();
    }, 15_000);

    const done = (status: Status, detail: string): void => {
      clearTimeout(timer);
      record('Deepgram agent', status, detail);
      try { socket.close(); } catch { /* already closing */ }
      resolve();
    };

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'Settings',
          audio: {
            input: { encoding: 'mulaw', sample_rate: 8000 },
            output: { encoding: 'mulaw', sample_rate: 8000, container: 'none' },
          },
          agent: {
            language: 'en',
            listen: { provider: { type: 'deepgram', model: 'nova-3' } },
            think: {
              provider: { type: 'open_ai', model: 'gpt-4o-mini' },
              prompt: 'You are a health check. Say nothing.',
            },
            speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } },
            greeting: 'Health check.',
          },
        }),
      );
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message: any;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'SettingsApplied' || message.type === 'Welcome') {
        if (message.type === 'SettingsApplied') {
          done('ok', 'agent socket open and settings accepted (mulaw 8k, tools declared)');
        }
      } else if (message.type === 'Error') {
        done('fail', `agent error: ${message.description ?? JSON.stringify(message).slice(0, 120)}`);
      }
    });

    socket.on('error', (error) => done('fail', String(error).slice(0, 160)));
    socket.on('close', (code) => {
      if (results.some((r) => r.service === 'Deepgram agent')) return;
      done('fail', `socket closed before settings were applied (code ${code})`);
    });
  });
}

/**
 * Loads one patient exactly the way a real call does and reports what the
 * agent would actually know. A context that silently comes back empty is the
 * failure mode most likely to survive all the checks above.
 */
async function checkPatientContext(patientId: string): Promise<void> {
  try {
    const { loadPatientContext } = await import('../orchestration/context.js');
    const context = await loadPatientContext({ patientId });

    record(
      'Patient context',
      context.mock ? 'mock' : 'ok',
      `${context.fullName} · module=${context.moduleId} · dob=${context.birthDate ?? 'MISSING'} · phone=${context.phone ?? 'MISSING'}`,
    );
    record(
      'Context detail',
      context.conditionId ? 'ok' : 'fail',
      `condition=${context.conditionDisplay ?? 'none'} · meds=${context.currentMedications.length} · allergies=${context.allergies.length} · triggers=${context.triggers.length} · priorScores=${context.priorScores.length}`,
    );

    if (!context.phone) {
      record('Context phone', 'fail', 'no phone on the Patient — an outbound call cannot be placed');
    }

    if (!context.coverage) {
      record('Context coverage', 'mock', 'no Coverage on file — eligibility will use the mock');
    } else {
      const complete =
        Boolean(context.coverage.memberId) &&
        Boolean(context.coverage.subscriberFirstName) &&
        Boolean(context.coverage.subscriberLastName) &&
        Boolean(context.coverage.subscriberDob);
      record(
        'Context coverage',
        complete ? 'ok' : 'mock',
        complete
          ? `payer=${context.coverage.payerId} · subscriber complete → live 270 possible`
          : 'subscriber name/DOB incomplete — the 270 will be rejected and fall back',
      );

      const eligibility = await checkEligibility(context.coverage);
      record(
        'Eligibility for patient',
        eligibility.mock ? 'mock' : 'ok',
        eligibility.mock
          ? 'deterministic mock'
          : `live 271 · covered=${eligibility.covered} · copay=${eligibility.copayUsd ?? 'n/a'} · plan=${eligibility.planName ?? 'n/a'}`,
      );
    }
  } catch (error) {
    record('Patient context', 'fail', String(error).slice(0, 200));
  }
}

async function main(): Promise<void> {
  console.log('\n\x1b[1mCareLoop — live integration check\x1b[0m');
  console.log(`Public base: ${env.publicHost ? `https://${env.publicHost}` : `http://localhost:${env.port}`}\n`);

  await checkMedplum();
  await checkMoss();
  await checkStedi();
  await checkLlm();
  await checkTwilio();
  await checkDeepgram();

  const patientIndex = process.argv.indexOf('--patient');
  const patientId =
    patientIndex >= 0 ? process.argv[patientIndex + 1] : env.seed.patientId || undefined;
  if (patientId) {
    console.log('');
    await checkPatientContext(patientId);
  }

  const failed = results.filter((r) => r.status === 'fail');
  const mocked = results.filter((r) => r.status === 'mock');

  console.log('');
  if (failed.length > 0) {
    console.log(`\x1b[31m${failed.length} check(s) failed:\x1b[0m ${failed.map((r) => r.service).join(', ')}`);
  }
  if (mocked.length > 0) {
    console.log(`\x1b[33m${mocked.length} check(s) are mock/degraded:\x1b[0m ${mocked.map((r) => r.service).join(', ')}`);
  }
  if (failed.length === 0 && mocked.length === 0) {
    console.log('\x1b[32mAll integrations are live.\x1b[0m');
  }
  console.log('');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
