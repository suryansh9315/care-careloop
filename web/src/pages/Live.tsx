import type { Patient } from '@medplum/fhirtypes';
import { CATEGORIES, communicationText, displayName, useLiveFeed } from '../data';
import { Avatar, Badge, Card, Empty, Icon, clockTime } from '../ui';

/**
 * The "watch documentation write itself" screen.
 *
 * Charting during a call is the product's central claim, so this view has to
 * be honest about it: the live indicator reflects a write in the last 30
 * seconds, and when nothing is arriving it says so rather than showing a
 * reassuring animation over a stale list.
 */
export function LivePage({
  patients,
  patientId,
  onSelect,
}: {
  patients: Patient[];
  patientId?: string;
  onSelect: (id: string) => void;
}): JSX.Element {
  const selected = patientId ?? patients[0]?.id;
  const { observations, chartLines, live } = useLiveFeed(selected, 2500);
  const patient = patients.find((p) => p.id === selected);

  function categoryOf(text: string[] | undefined): string {
    const category = text?.[0] ?? '';
    if (category === CATEGORIES.concern) return 'Concern';
    if (category === CATEGORIES.education) return 'Education';
    if (category === CATEGORIES.coverage) return 'Coverage';
    return 'Chart';
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Live</h1>
          <p className="sub">Charting as it happens during the call.</p>
        </div>
        <div className="spacer" />
        {live ? <Badge tone="live">Charting now</Badge> : <Badge tone="routine">Idle</Badge>}
      </header>

      <div className="grid-review">
        <Card title="Patients">
          {patients.length === 0 ? (
            <Empty>No patients yet.</Empty>
          ) : (
            patients.map((p) => {
              const name = displayName(p);
              return (
                <button
                  key={p.id}
                  className={`row ${p.id === selected ? 'selected' : ''}`}
                  onClick={() => p.id && onSelect(p.id)}
                >
                  <Avatar name={name} small />
                  <span className="grow">
                    <span className="name">{name}</span>
                    <span className="meta">
                      {p.telecom?.find((t) => t.system === 'phone')?.value ?? 'no phone'}
                    </span>
                  </span>
                  <span className="chev">{Icon.chevron()}</span>
                </button>
              );
            })
          )}
        </Card>

        <div className="stack">
          <div className={`livebar${live ? ' on' : ''}`}>
            <span className="beat" />
            <div style={{ minWidth: 0 }}>
              <div className="lt">{live ? 'Charting live' : patient ? `${displayName(patient)} · idle` : 'Idle'}</div>
              <div className="ls">
                {live
                  ? 'Documentation is being written as the patient answers'
                  : 'Nothing has been charted in the last 30 seconds'}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <span className="pill">{chartLines.length} entries</span>
            <span className="pill">{observations.length} coded</span>
          </div>

          <Card
            title={patient ? displayName(patient) : 'Charting feed'}
            subtitle={
              live
                ? 'Updating every few seconds'
                : 'Nothing has been charted in the last 30 seconds'
            }
            action={live ? <Badge tone="live">Live</Badge> : undefined}
          >
            {chartLines.length === 0 ? (
              <Empty>
                Nothing charted yet. Start a call from New intake and this fills in as the patient
                answers.
              </Empty>
            ) : (
              chartLines.slice(0, 40).map((line) => (
                <div key={line.id} className="feed-item">
                  <span className="feed-time">{clockTime(line.sent)}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <Badge tone={categoryOf(line.category?.map((c) => c.text ?? '')) === 'Concern' ? 'urgent' : 'brand'}>
                      {categoryOf(line.category?.map((c) => c.text ?? ''))}
                    </Badge>
                    <span style={{ display: 'block', marginTop: 5 }}>
                      {communicationText(line)}
                    </span>
                  </span>
                </div>
              ))
            )}
          </Card>

          <Card title="Coded observations" subtitle="Written to the record as the patient answers">
            {observations.length === 0 ? (
              <Empty>No observations yet.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Code</th>
                    <th>Value</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {observations.slice(0, 25).map((obs) => (
                    <tr key={obs.id}>
                      <td className="mono">{clockTime(obs.effectiveDateTime ?? obs.issued)}</td>
                      <td className="mono">{obs.code?.coding?.[0]?.code ?? '—'}</td>
                      <td>
                        <strong>{obs.valueInteger ?? obs.valueQuantity?.value ?? '—'}</strong>
                        {obs.valueQuantity?.unit === '{score}' && (
                          <span className="muted small"> total</span>
                        )}
                      </td>
                      <td>
                        <Badge tone={obs.status === 'final' ? 'ok' : 'info'}>{obs.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
