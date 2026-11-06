import { MedplumClient, type LoginAuthenticationResponse } from '@medplum/core';

/**
 * The dashboard authenticates as a *user*, not as the bridge.
 *
 * There is no client secret in this bundle by design: the bridge's server-side
 * credential can read and write every patient in the project, and the browser
 * must never hold it. The signed-in clinician's own Medplum session decides
 * what this app can see.
 */
import { mockMedplum } from './mock';

const realMedplum = new MedplumClient({
  baseUrl: import.meta.env.VITE_MEDPLUM_BASE_URL || 'https://api.medplum.com/',
  clientId: import.meta.env.VITE_MEDPLUM_CLIENT_ID || undefined,
  cacheTime: 10_000,
});

// VITE_MOCK swaps in an in-memory fixture backend for local visual development
// (no Medplum login). It is off unless the flag is explicitly set.
export const medplum: MedplumClient = (import.meta.env.VITE_MOCK
  ? (mockMedplum as unknown as MedplumClient)
  : realMedplum);

export const PROJECT_ID = import.meta.env.VITE_MEDPLUM_PROJECT_ID || undefined;

export async function signIn(email: string, password: string): Promise<void> {
  const response: LoginAuthenticationResponse = await medplum.startLogin({
    email,
    password,
    remember: true,
    ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
  });

  if (response.mfaRequired) {
    throw new Error('This account requires multi-factor authentication, which this dashboard does not implement.');
  }

  let code = response.code;

  // When the user belongs to more than one project, Medplum asks which profile
  // to use before issuing a code.
  if (!code && response.memberships?.length) {
    const membership = response.memberships[0];
    await medplum.post('auth/profile', {
      login: response.login,
      profile: membership.id,
    });
    const scoped = (await medplum.post('auth/scope', {
      login: response.login,
      scope: 'openid',
    })) as LoginAuthenticationResponse;
    code = scoped.code;
  }

  if (!code) {
    throw new Error('Medplum did not return an authorization code.');
  }

  await medplum.processCode(code);
}

export function signOut(): void {
  medplum.signOut().catch(() => undefined);
}
