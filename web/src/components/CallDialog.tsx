import { useState } from 'react';
import { startCall } from '../bridge';
import { Badge, Icon, Modal } from '../ui';

export interface CallTarget {
  patientId: string;
  name: string;
  phone?: string;
  /** Pre-selected treatment, when the caller already knows it. */
  moduleId?: string;
}

/**
 * Confirmation before dialling.
 *
 * A phone call reaches a real person and cannot be taken back, so it is always
 * behind an explicit confirm that shows exactly who is about to be rung and on
 * what number.
 *
 * When the patient has no coded condition the bridge answers 422 with the
 * treatments to choose from, and this becomes a picker in place rather than an
 * error the clinician has to go and fix elsewhere.
 */
export function CallDialog({
  target,
  onClose,
  onStarted,
}: {
  target: CallTarget;
  onClose: () => void;
  onStarted: (patientId: string) => void;
}): JSX.Element {
  const [moduleId, setModuleId] = useState(target.moduleId ?? '');
  const [choices, setChoices] = useState<Array<{ id: string; display: string }>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [mockNotice, setMockNotice] = useState(false);

  async function dial(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await startCall(target.patientId, moduleId || undefined);
      if (result.mock) {
        setMockNotice(true);
        return;
      }
      onStarted(target.patientId);
      onClose();
    } catch (err) {
      const detail = err as { message?: string; needsModule?: boolean; modules?: Array<{ id: string; display: string }> };
      if (detail.needsModule && detail.modules) {
        setChoices(detail.modules);
        setModuleId(detail.modules[0]?.id ?? '');
        setError('This patient has no condition on file. Choose the treatment for this call.');
        return;
      }
      setError(detail.message ?? 'Could not start the call.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={mockNotice ? 'Twilio is in mock mode' : `Call ${target.name}?`}
      onClose={onClose}
      footer={
        mockNotice ? (
          <button className="btn primary" onClick={onClose}>Close</button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn primary"
              onClick={dial}
              disabled={busy || (Boolean(choices) && !moduleId) || !target.phone}
            >
              {Icon.phone()} {busy ? 'Dialling…' : 'Call now'}
            </button>
          </>
        )
      }
    >
      {mockNotice ? (
        <p className="small">
          No real call was placed. Set the Twilio credentials in <span className="mono">.env</span>{' '}
          to dial for real.
        </p>
      ) : (
        <>
          <p>
            This places a real phone call to{' '}
            <strong className="mono">{target.phone ?? 'no number on file'}</strong>. Only continue
            if the patient is expecting it.
          </p>

          {!target.phone && (
            <div className="notice error" style={{ marginTop: 14 }}>
              No phone number is recorded for this patient.
            </div>
          )}

          {error && <div className="notice warn" style={{ marginTop: 14 }}>{error}</div>}

          {choices && (
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="call-module">Treatment for this call</label>
              <select id="call-module" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
                {choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>{choice.display}</option>
                ))}
              </select>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <Badge tone="info">Maya verifies date of birth before any clinical question</Badge>
          </div>
        </>
      )}
    </Modal>
  );
}
