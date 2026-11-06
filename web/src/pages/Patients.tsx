import type { Patient } from '@medplum/fhirtypes';
import { useState } from 'react';
import { CallDialog, type CallTarget } from '../components/CallDialog';
import { displayName } from '../data';
import { Avatar, Badge, Card, Empty, Icon, MetricStrip, relativeTime } from '../ui';

export function PatientsPage({
  patients,
  onOpenLive,
  onOpenPatient,
}: {
  patients: Patient[];
  onOpenLive: (patientId: string) => void;
  onOpenPatient: (patientId: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<CallTarget>();

  const filtered = patients.filter((p) =>
    displayName(p).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const reachable = patients.filter((p) => p.telecom?.some((t) => t.system === 'phone' && t.value)).length;
  const recent = patients.filter(
    (p) => p.meta?.lastUpdated && Date.now() - new Date(p.meta.lastUpdated).getTime() < 7 * 86400000,
  ).length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Patients</h1>
          <p className="sub">{patients.length} in your workspace.</p>
        </div>
        <div className="spacer" />
        <div className="search-field" style={{ width: 260 }}>
          <span className="search-ic">{Icon.search()}</span>
          <input
            placeholder="Search by name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search patients"
          />
        </div>
      </header>

      <div style={{ marginBottom: 16 }}>
        <MetricStrip
          items={[
            { label: 'Total patients', value: patients.length, tone: 'brand' },
            { label: 'Reachable by phone', value: reachable, tone: 'ok' },
            { label: 'Active this week', value: recent, tone: 'info' },
          ]}
        />
      </div>

      {target && (
        <CallDialog
          target={target}
          onClose={() => setTarget(undefined)}
          onStarted={onOpenLive}
        />
      )}

      <Card title="Directory" subtitle={`${filtered.length} shown`}>
        {filtered.length === 0 ? (
          query ? (
            <Empty title="No matches">
              Nothing matches “{query}”. Clear the search to see all {patients.length} patients.
            </Empty>
          ) : (
            <Empty title="No patients yet">
              Create one from New intake — that also sets up the condition and questionnaire.
            </Empty>
          )
        ) : (
          filtered.map((patient) => {
            const name = displayName(patient);
            const phone = patient.telecom?.find((t) => t.system === 'phone')?.value;
            return (
              <div key={patient.id} className="row" style={{ cursor: 'default' }}>
                <button
                  className="row-open"
                  onClick={() => patient.id && onOpenPatient(patient.id)}
                  title={`Open ${name}'s record`}
                >
                  <Avatar name={name} />
                  <span className="grow">
                    <span className="name">{name}</span>
                    <span className="meta">
                      {patient.birthDate ? `DOB ${patient.birthDate}` : 'No DOB'}
                      {phone ? ` · ${phone}` : ' · no phone'}
                    </span>
                  </span>
                </button>
                {patient.meta?.lastUpdated && (
                  <span className="small muted">{relativeTime(patient.meta.lastUpdated)}</span>
                )}
                {!phone && <Badge tone="routine">no phone</Badge>}
                <button
                  className="btn"
                  disabled={!phone}
                  title={phone ? `Call ${name}` : 'No phone number on file'}
                  onClick={() =>
                    patient.id && setTarget({ patientId: patient.id, name, phone })
                  }
                >
                  {Icon.phone()} Call
                </button>
                <button
                  className="btn"
                  onClick={() => patient.id && onOpenLive(patient.id)}
                  title="Live charting feed"
                >
                  {Icon.live()} Live
                </button>
              </div>
            );
          })
        )}
      </Card>
    </>
  );
}
