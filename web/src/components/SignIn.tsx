import { useState, type FormEvent } from 'react';
import { signIn } from '../medplum';
import { Card, Icon } from '../ui';

export function SignIn({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin-wrap">
      <div className="signin">
        <div className="app-brand">
          <span className="brand-mark">
            <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h4l3 8 4-16 3 8h4" />
            </svg>
          </span>
          <span className="brand-name">CareLoop</span>
        </div>

        <Card padded>
          <h2 style={{ fontSize: 18 }}>Clinician sign-in</h2>
          <p className="small muted" style={{ marginTop: 6, marginBottom: 18 }}>
            Sign in with your Medplum account. This dashboard reads live FHIR data scoped to your
            own session — there is no client secret in the browser.
          </p>

          {error && <div className="notice error" style={{ marginBottom: 14 }}>{error}</div>}

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="username" value={email}
                onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <button className="btn primary" type="submit" disabled={busy}
              style={{ marginTop: 18, width: '100%' }}>
              {busy ? 'Signing in…' : 'Sign in'}
              {!busy && Icon.arrowRight()}
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}
