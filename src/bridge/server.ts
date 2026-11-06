import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { env, live, publicBaseUrl } from '../config/env.js';
import { listModules, reloadFromStore, tryGetModule } from '../conditions/registry.js';
import { saveModule, storedModuleSchema, validateStoredModule } from '../conditions/store.js';
import {
  buildStreamTwiml,
  placeOutboundCall,
  validateTwilioSignature,
} from '../integrations/twilio.js';
import { recordCall } from '../integrations/calllog.js';
import { logger } from '../logger.js';
import { UnresolvedModuleError, loadPatientContext } from '../orchestration/context.js';
import { createIntake } from '../orchestration/intake.js';
import { approvePlan, unapprovePlan } from '../orchestration/plan.js';
import {
  CallSession,
  activeSessionCount,
  getSession,
  registerSession,
  removeSession,
  routeTwilioSocket,
} from './session.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// The dashboard runs on a different origin and authenticates to Medplum
// directly; it only needs these bridge endpoints.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CareLoop-Secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

/** Shared-secret gate for anything that writes or dials out. */
function requireSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const provided = req.header('X-CareLoop-Secret');
  if (provided !== env.toolSharedSecret) {
    res.status(401).json({ error: 'unauthorised' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Health and metadata
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    activeCalls: activeSessionCount(),
    publicBaseUrl: publicBaseUrl(),
    // Explicitly surfaced so it is always obvious which results are real.
    live,
  });
});

function moduleSummary(module: ReturnType<typeof listModules>[number]) {
  return {
    id: module.id,
    display: module.display,
    icd10: module.icd10,
    snomed: module.snomed,
    instrument: module.instrument.name,
    items: module.instrument.items.length,
    riskQuestions: module.riskQuestions.length,
    bands: module.bands.length,
    medications: Object.values(module.steps).reduce(
      (total, step) => total + step.medications.length,
      0,
    ),
  };
}

app.get('/modules', (_req, res) => res.json(listModules().map(moduleSummary)));

// --- Treatments as data -----------------------------------------------
// `/conditions` is the authoring API. A module drives medication selection,
// so writes are validated hard and a bad one is rejected outright rather than
// partially applied.

app.get('/conditions', (_req, res) => res.json(listModules().map(moduleSummary)));

app.get('/conditions/:id', (req, res) => {
  const module = tryGetModule(req.params.id);
  if (!module) {
    res.status(404).json({ error: 'unknown module' });
    return;
  }
  res.json(module);
});

app.put('/conditions/:id', requireSecret, async (req, res) => {
  const parsed = storedModuleSchema.safeParse({ ...req.body, id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid module', issues: parsed.error.issues });
    return;
  }

  const problems = validateStoredModule(parsed.data);
  if (problems.length > 0) {
    res.status(422).json({ error: 'module failed clinical validation', problems });
    return;
  }

  try {
    await saveModule(parsed.data);
    // Hot reload: the next call uses the new flow without a restart.
    const { stored, total } = await reloadFromStore();
    logger.info({ module: parsed.data.id, stored, total }, 'conditions.reloaded');
    res.json({ saved: parsed.data.id, modules: total });
  } catch (error) {
    logger.error({ err: String(error) }, 'conditions.save.failed');
    res.status(500).json({ error: 'could not save module' });
  }
});

app.post('/conditions/reload', requireSecret, async (_req, res) => {
  const result = await reloadFromStore();
  res.json(result);
});

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

const intakeSchema = z.object({
  moduleId: z.string().min(1),
  givenName: z.string().min(1),
  familyName: z.string().min(1),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  phone: z.string().min(5),
  gender: z.enum(['male', 'female', 'other', 'unknown']).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  coverage: z
    .object({
      payerId: z.string(),
      payerName: z.string().optional(),
      memberId: z.string(),
      subscriberFirstName: z.string().optional(),
      subscriberLastName: z.string().optional(),
      subscriberDob: z.string().optional(),
    })
    .optional(),
  allergies: z.array(z.string()).optional(),
  triggers: z.array(z.string()).optional(),
});

app.post('/intake', requireSecret, async (req, res) => {
  const parsed = intakeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid intake', issues: parsed.error.issues });
    return;
  }
  try {
    const result = await createIntake(parsed.data);
    res.status(201).json(result);
  } catch (error) {
    logger.error({ err: String(error) }, 'intake.failed');
    res.status(500).json({ error: 'intake failed' });
  }
});

// ---------------------------------------------------------------------------
// Outbound call
// ---------------------------------------------------------------------------

const callSchema = z.object({
  patientId: z.string().min(1),
  moduleId: z.string().optional(),
  /** Overrides the phone on the Patient resource. */
  phone: z.string().optional(),
});

app.post('/call', requireSecret, async (req, res) => {
  const parsed = callSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid call request', issues: parsed.error.issues });
    return;
  }

  try {
    const context = await loadPatientContext({
      patientId: parsed.data.patientId,
      moduleId: parsed.data.moduleId,
    });
    const to = parsed.data.phone ?? context.phone;
    if (!to) {
      res.status(400).json({ error: 'no phone number on file for this patient' });
      return;
    }

    const callId = randomUUID();
    const session = new CallSession(callId, context);
    registerSession(session);

    const call = await placeOutboundCall(to, callId);
    session.callSid = call.callSid;
    logger.info({ callId, callSid: call.callSid, mock: call.mock }, 'call.started');

    void recordCall({
      callId,
      callSid: call.callSid,
      patientId: context.patientId,
      status: 'initiated',
      direction: 'outbound',
      moduleId: context.moduleId,
      mock: call.mock,
    });

    res.status(202).json({ callId, callSid: call.callSid, mock: call.mock });
  } catch (error) {
    // A patient with no coded condition is a routine situation the clinician
    // can fix by naming the treatment — it must not read as a server fault.
    if (error instanceof UnresolvedModuleError) {
      logger.info({ patientId: parsed.data.patientId }, 'call.needs-module');
      res.status(422).json({
        error: error.message,
        needsModule: true,
        modules: listModules().map((module) => ({ id: module.id, display: module.display })),
      });
      return;
    }
    logger.error({ err: String(error) }, 'call.failed');
    res.status(500).json({ error: 'could not start call' });
  }
});

// ---------------------------------------------------------------------------
// Twilio webhooks
// ---------------------------------------------------------------------------

/**
 * Twilio signature verification. The webhook is a public URL that triggers a
 * media stream and post-call FHIR writes, so an unsigned caller must not be
 * able to drive it. Verification is skipped only when Twilio is not configured
 * at all (mock mode), which is also when there is nothing to forge.
 */
function verifyTwilioSignature(req: express.Request, res: express.Response): boolean {
  const url = `${publicBaseUrl()}${req.originalUrl}`;
  if (validateTwilioSignature(req.header('X-Twilio-Signature'), url, req.body ?? {})) {
    return true;
  }
  logger.warn({ url }, 'twilio.signature.invalid');
  res.status(403).type('text/plain').send('Invalid Twilio signature');
  return false;
}

app.post('/voice', (req, res) => {
  if (!verifyTwilioSignature(req, res)) return;

  const callId = String(req.query.callId ?? '');
  const session = callId ? getSession(callId) : undefined;
  if (!session) {
    logger.warn({ callId }, 'voice.unknown-call');
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this call could not be set up. Goodbye.</Say><Hangup/></Response>`,
    );
    return;
  }
  res.type('text/xml').send(
    buildStreamTwiml({
      callId,
      patientId: session.context.patientId,
      conditionId: session.context.moduleId,
    }),
  );
});

app.post('/voice/status', (req, res) => {
  const callId = String(req.query.callId ?? '');
  const status = String(req.body?.CallStatus ?? '');
  logger.info({ callId, status }, 'twilio.call.status');

  const logged = getSession(callId);
  if (logged?.callSid) {
    void recordCall({
      callId,
      callSid: logged.callSid,
      patientId: logged.context.patientId,
      status: status as never,
      direction: 'outbound',
      moduleId: logged.context.moduleId,
      answered: logged.state.answers.size,
    });
  }

  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
    const session = getSession(callId);
    void session?.end(`twilio-${status}`);
    // Keep the session briefly so a late post-call write can still resolve it.
    setTimeout(() => removeSession(callId), 60_000).unref();
  }
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Clinician approval
// ---------------------------------------------------------------------------

const approveSchema = z.object({
  carePlanId: z.string().min(1),
  approverReference: z.string().optional(),
  hasCriticalFlag: z.boolean().default(false),
  acknowledgedCriticalFlags: z.boolean().default(false),
});

app.post('/plans/approve', requireSecret, async (req, res) => {
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid approval', issues: parsed.error.issues });
    return;
  }
  const result = await approvePlan(parsed.data);
  res.status(result.approved ? 200 : 409).json(result);
});

const unapproveSchema = z.object({
  carePlanId: z.string().min(1),
  reverserReference: z.string().optional(),
  reason: z.string().max(500).optional(),
});

app.post('/plans/unapprove', requireSecret, async (req, res) => {
  const parsed = unapproveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
    return;
  }
  const result = await unapprovePlan(parsed.data);
  res.status(result.reverted ? 200 : 409).json(result);
});

// ---------------------------------------------------------------------------
// WebSocket: Twilio bidirectional media stream
// ---------------------------------------------------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

/**
 * Reject with a real HTTP response rather than destroying the socket.
 *
 * An aborted TCP connection mid-upgrade is reported by every reverse proxy as a
 * generic 502, which is indistinguishable from the proxy itself refusing to
 * carry WebSockets. Answering properly makes the difference diagnosable from
 * outside — a 404 here means the tunnel forwarded the upgrade correctly and the
 * call id was simply unknown.
 */
function rejectUpgrade(socket: import('node:stream').Duplex, status: number, reason: string): void {
  const body = `${status} ${reason}`;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  if (url.pathname !== '/twilio') {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }
  // The query string is a hint only — Twilio may drop it. The socket is
  // accepted regardless and resolved from the `start` frame's parameters.
  const callIdHint = url.searchParams.get('callId') ?? undefined;
  logger.info({ callIdHint: callIdHint ?? '(none)' }, 'ws.upgrade.accepted');
  wss.handleUpgrade(request, socket, head, (ws) => {
    routeTwilioSocket(ws, callIdHint);
  });
});

server.listen(env.port, () => {
  logger.info(
    { port: env.port, publicBaseUrl: publicBaseUrl(), live },
    'careloop.bridge.listening',
  );

  // Hydrate stored treatments once the port is open, so a slow or failing
  // FHIR server delays authoring but never delays accepting calls.
  void reloadFromStore()
    .then(({ stored, total }) => logger.info({ stored, total }, 'conditions.hydrated.startup'))
    .catch((error) => logger.warn({ err: String(error) }, 'conditions.hydrate.startup.failed'));

  for (const [name, enabled] of Object.entries(live)) {
    if (!enabled) logger.warn(`${name} is in MOCK mode — results are not real`);
  }
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'careloop.bridge.shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, server };
