import { useEffect, useState, type FormEvent } from 'react';
import { createIntake, getModules, type ModuleSummary } from '../bridge';
import { CallDialog } from '../components/CallDialog';
import { Badge, Card, Icon } from '../ui';

/**
 * Creates the patient, then dials as a separate explicit step.
 *
 * Dialling reaches a real person, so it is deliberately not part of the same
 * submit — a mistyped form should never place a call.
 */
export function IntakePage({
  onCallStarted,
}: {
  onCallStarted: (patientId: string) => void;
}): JSX.Element {
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [moduleId, setModuleId] = useState('asthma');
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [payerId, setPayerId] = useState('');
  const [payerName, setPayerName] = useState('');
  const [memberId, setMemberId] = useState('');
  const [allergies, setAllergies] = useState('');
  const [triggers, setTriggers] = useState('');

  const [created, setCreated] = useState<{ patientId: string; moduleId: string }>();
  const [busy, setBusy] = useState(false);
  const [dialing, setDialing] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string }>();

  useEffect(() => {
    getModules()
      .then((list) => {
        setModules(list);
        if (list[0]) setModuleId(list[0].id);
      })
      .catch(() => setMessage({ kind: 'error', text: 'Could not reach the CareLoop bridge.' }));
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await createIntake({
        moduleId,
        givenName,
        familyName,
        birthDate,
        phone,
        ...(gender ? { gender: gender as 'male' | 'female' | 'other' | 'unknown' } : {}),
        ...(city ? { city } : {}),
        ...(stateRegion ? { state: stateRegion } : {}),
        ...(payerId && memberId
          ? { coverage: { payerId, memberId, ...(payerName ? { payerName } : {}) } }
          : {}),
        allergies: allergies.split(',').map((s) => s.trim()).filter(Boolean),
        triggers: triggers.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setCreated({ patientId: result.patientId, moduleId: result.moduleId });
      setMessage({ kind: 'ok', text: `${givenName} ${familyName} created.` });
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Intake failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  const selected = modules.find((m) => m.id === moduleId);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>New intake</h1>
          <p className="sub">Create the record, then start the check-in call.</p>
        </div>
      </header>

      {dialing && created && (
        <CallDialog
          target={{
            patientId: created.patientId,
            name: `${givenName} ${familyName}`.trim(),
            phone,
            moduleId: created.moduleId,
          }}
          onClose={() => setDialing(false)}
          onStarted={onCallStarted}
        />
      )}

      <div className="grid-2">
        <Card title="Patient" padded>
          {message && <div className={`notice ${message.kind}`} style={{ marginBottom: 16 }}>{message.text}</div>}

          <form onSubmit={submit}>
            <fieldset>
              <legend>Condition</legend>
              <div className="field">
                <label htmlFor="module">Treatment module</label>
                <select id="module" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
                  {modules.map((m) => (
                    <option key={m.id} value={m.id}>{m.display}</option>
                  ))}
                </select>
                {selected && (
                  <div style={{ marginTop: 10 }}>
                    <p className="small muted" style={{ marginBottom: 8 }}>{selected.instrument}</p>
                    <div className="pills">
                      <span className="pill">{selected.items} items</span>
                      {selected.riskQuestions !== undefined && (
                        <span className="pill">{selected.riskQuestions} risk questions</span>
                      )}
                      {selected.bands !== undefined && <span className="pill">{selected.bands} bands</span>}
                      {selected.medications !== undefined && (
                        <span className="pill">{selected.medications} orders</span>
                      )}
                      {selected.icd10 && <span className="pill">ICD-10 {selected.icd10}</span>}
                    </div>
                  </div>
                )}
              </div>
            </fieldset>

            <fieldset>
              <legend>Identity</legend>
              <div className="form-grid">
                <div>
                  <label htmlFor="given">First name</label>
                  <input id="given" value={givenName} onChange={(e) => setGivenName(e.target.value)} required />
                </div>
                <div>
                  <label htmlFor="family">Last name</label>
                  <input id="family" value={familyName} onChange={(e) => setFamilyName(e.target.value)} required />
                </div>
                <div>
                  <label htmlFor="dob">Date of birth</label>
                  <input id="dob" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} required />
                </div>
                <div>
                  <label htmlFor="phone">Phone (E.164)</label>
                  <input id="phone" placeholder="+15555550123" value={phone} onChange={(e) => setPhone(e.target.value)} required />
                </div>
                <div>
                  <label htmlFor="gender">Sex</label>
                  <select id="gender" value={gender} onChange={(e) => setGender(e.target.value)}>
                    <option value="">Not recorded</option>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="city">City</label>
                  <input id="city" placeholder="Oakland" value={city} onChange={(e) => setCity(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="state">State</label>
                  <input id="state" placeholder="CA" value={stateRegion} onChange={(e) => setStateRegion(e.target.value)} />
                </div>
              </div>
            </fieldset>

            <fieldset>
              <legend>Insurance (optional)</legend>
              <div className="form-grid">
                <div>
                  <label htmlFor="payer">Payer ID</label>
                  <input id="payer" value={payerId} onChange={(e) => setPayerId(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="payerName">Plan name</label>
                  <input id="payerName" placeholder="Gold Plan HMO" value={payerName} onChange={(e) => setPayerName(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="member">Member ID</label>
                  <input id="member" value={memberId} onChange={(e) => setMemberId(e.target.value)} />
                </div>
              </div>
            </fieldset>

            <fieldset>
              <legend>Clinical context (optional)</legend>
              <div className="form-grid">
                <div>
                  <label htmlFor="allergies">Drug allergies</label>
                  <input id="allergies" placeholder="penicillin, sulfa" value={allergies} onChange={(e) => setAllergies(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="triggers">Triggers</label>
                  <input id="triggers" placeholder="dust mite, cold air" value={triggers} onChange={(e) => setTriggers(e.target.value)} />
                </div>
              </div>
            </fieldset>

            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Working…' : 'Create patient'}
            </button>
          </form>
        </Card>

        <Card title="Start the check-in" padded>
          {!created ? (
            <p className="muted small">
              Create the patient first. The call is a separate step so a mistyped form can never
              dial someone.
            </p>
          ) : (
            <>
              <p style={{ fontWeight: 600 }}>{givenName} {familyName}</p>
              <p className="small muted" style={{ marginTop: 4 }}>{phone}</p>
              <p className="small mono muted" style={{ marginTop: 10 }}>{created.patientId}</p>
              <div style={{ marginTop: 18 }}>
                <Badge tone="info">Maya will verify DOB before any clinical question</Badge>
              </div>
              <button
                className="btn primary"
                onClick={() => setDialing(true)}
                disabled={busy}
                style={{ marginTop: 18 }}
              >
                {Icon.phone()} Call {givenName || 'patient'} now
              </button>
              <p className="small muted" style={{ marginTop: 12 }}>
                This places a real phone call. Only do it when the patient is expecting it.
              </p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
