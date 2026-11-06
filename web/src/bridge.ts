/**
 * Calls to the CareLoop bridge (intake, outbound dialling, approval).
 *
 * The shared secret here is a local-development convenience. Shipping it in a
 * browser bundle is not a production pattern: a real deployment should have the
 * dashboard present the clinician's own Medplum token and have the bridge
 * verify it.
 */

const BASE = import.meta.env.VITE_BRIDGE_URL || 'http://localhost:3000';
const SECRET = import.meta.env.VITE_BRIDGE_SECRET || 'dev-secret';

async function requestMethod<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-CareLoop-Secret': SECRET,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Bridge returned ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    // Structured detail is carried onto the error rather than flattened into a
    // string: a 422 that names the recoverable problem lets the UI offer the
    // fix in place instead of just reporting failure.
    const detail =
      parsed.problems?.join('; ') ??
      parsed.issues?.map((i: any) => `${i.path?.join('.')}: ${i.message}`).join('; ');
    const error = new Error(
      detail ? `${parsed.error}: ${detail}` : parsed.error ?? `Bridge returned ${response.status}`,
    ) as Error & { status?: number; needsModule?: boolean; modules?: unknown };
    error.status = response.status;
    if (parsed.needsModule) {
      error.needsModule = true;
      error.modules = parsed.modules;
      error.message = parsed.error;
    }
    throw error;
  }
  return parsed as T;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  return requestMethod<T>(body === undefined ? 'GET' : 'POST', path, body);
}

export interface BridgeHealth {
  ok: boolean;
  activeCalls: number;
  live: Record<string, boolean>;
}

export const getHealth = () => request<BridgeHealth>('/health');

export interface ModuleSummary {
  id: string;
  display: string;
  instrument: string;
  items: number;
  icd10?: string;
  snomed?: string;
  riskQuestions?: number;
  bands?: number;
  medications?: number;
}

export const getModules = () => request<ModuleSummary[]>('/modules');

export interface IntakePayload {
  moduleId: string;
  givenName: string;
  familyName: string;
  birthDate: string;
  phone: string;
  gender?: 'male' | 'female' | 'other' | 'unknown';
  city?: string;
  state?: string;
  coverage?: { payerId: string; payerName?: string; memberId: string };
  allergies?: string[];
  triggers?: string[];
}

export const createIntake = (payload: IntakePayload) =>
  request<{ patientId: string; conditionId: string; moduleId: string }>('/intake', payload);

export const startCall = (patientId: string, moduleId?: string) =>
  request<{ callId: string; callSid: string; mock: boolean }>('/call', { patientId, moduleId });

export const getCondition = (id: string) => request<Record<string, unknown>>(`/conditions/${id}`);

export const saveCondition = (id: string, module: unknown) =>
  requestMethod<{ saved: string; modules: number }>('PUT', `/conditions/${id}`, module);

export const reloadConditions = () =>
  request<{ stored: number; total: number }>('/conditions/reload', {});

export const approve = (input: {
  carePlanId: string;
  hasCriticalFlag: boolean;
  acknowledgedCriticalFlags: boolean;
  approverReference?: string;
}) => request<{ approved: boolean; reason?: string }>('/plans/approve', input);

/** Reverses an approval: the plan and its orders return to draft for review. */
export const unapprove = (input: { carePlanId: string; reason?: string; reverserReference?: string }) =>
  request<{ reverted: boolean; reason?: string }>('/plans/unapprove', input);
