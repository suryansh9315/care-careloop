import type { CarePlan, Patient } from '@medplum/fhirtypes';
import { useEffect, useState } from 'react';
import { CallDialog, type CallTarget } from '../components/CallDialog';
import { Trend } from '../components/Trend';
import {
  communicationText,
  displayName,
  useCalls,
  useLiveFeed,
  usePatientPlans,
} from '../data';
import { medplum } from '../medplum';
import { Avatar, Badge, Card, Empty, Icon, MetricStrip, Sparkline, clockTime, relativeTime } from '../ui';

/**
 * Approval stamps a note on the plan; surfacing it is what makes an approved
 * plan auditable at a glance rather than just "active".
 */
function approvedLabel(plan: CarePlan): string | undefined {
  const note = plan.note?.map((n) => n.text ?? '').find((t) => /^Approved at /i.test(t));
  const iso = note?.match(/Approved at (\S+?)(?:\s|\.|$)/)?.[1];
  if (!iso) return undefined;
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? 'approved' : `approved ${relativeTime(iso)}`;
}

/**
 * The single place a patient comes together.
 *
 * Every other screen is a queue or a stream sliced across all patients; this is
 * the one view scoped to a person — their record, their plans, their calls and
 * their scores — so a clinician can act without stitching the picture together
 * from four tabs. It is the hub the other screens link into.
 */
export function PatientPage({
  patientId,
  patients,
  onOpenPlan,
  onOpenLive,
  onBack,
}: {
  patientId: string;
  patients: Patient[];
  onOpenPlan: (plan: CarePlan) => void;
  onOpenLive: (patientId: string) => void;
  onBack: () => void;
}): JSX.Element {
  const fromList = patients.find((p) => p.id === patientId);
  const [patient, setPatient] = useState<Patient | undefined>(fromList);
  const [target, setTarget] = useState<CallTarget>();

  const { plans } = usePatientPlans(patientId);
  const { observations, chartLines, live } = useLiveFeed(patientId, 4000);
  const allCalls = useCalls();
  const calls = allCalls.filter((c) => c.patientReference === `Patient/${patientId}`);

  // The list only holds the first hundred patients; a hub opened from a deep
  // link or an older call must still resolve the person.
  useEffect(() => {
    if (fromList) {
      setPatient(fromList);
      return;
    }
    let cancelled = false;
    medplum
      .readResource('Patient', patientId)
      .then((p) => !cancelled && setPatient(p))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [patientId, fromList]);

  const name = patient ? displayName(patient) : 'Loading…';
  const phone = patient?.telecom?.find((t) => t.system === 'phone')?.value;
  const email = patient?.telecom?.find((t) => t.system === 'email')?.value;

  const drafts = plans.filter((p) => p.status === 'draft');
  const activePlans = plans.filter((p) => p.status === 'active');
  const others = plans.filter((p) => p.status !== 'draft' && p.status !== 'active');

  const scores = observations
    .filter((o) => o.valueQuantity?.unit === '{score}')
    .slice()
    .reverse();
  const trendPoints = scores.map((obs) => ({
    date: obs.effectiveDateTime ?? obs.issued ?? '',
    total: obs.valueQuantity?.value ?? 0,
  }));
  const trendMax = Math.max(25, ...trendPoints.map((p) => p.total));
  const latestScore = trendPoints[trendPoints.length - 1]?.total;
  const priorScore = trendPoints[trendPoints.length - 2]?.total;
  const delta = latestScore !== undefined && priorScore !== undefined ? latestScore - priorScore : undefined;
  const sparkValues = trendPoints.map((p) => p.total);

  return (
    <>
      <header className="page-head">
        <button className="btn ghost" onClick={onBack} aria-label="Back to patients">
          {Icon.chevronLeft()} Patients
        </button>
        <div style={{ marginLeft: 4 }}>
          <h1>{name}</h1>
          <p className="sub">
            {patient?.birthDate ? `DOB ${patient.birthDate}` : 'No DOB on file'}
            {phone ? ` · ${phone}` : ' · no phone'}
          </p>
        </div>
        <div className="spacer" />
        {live && <Badge tone="live">Charting now</Badge>}
        <button
          className="btn"
          onClick={() => onOpenLive(patientId)}
          title="Open the live charting feed"
        >
          {Icon.live()} Charting feed
        </button>
        <button
          className="btn primary"
          disabled={!phone}
          title={phone ? `Call ${name}` : 'No phone number on file'}
          onClick={() => setTarget({ patientId, name, phone })}
        >
          {Icon.phone()} Call
        </button>
      </header>

      {target && (
        <CallDialog
          target={target}
          onClose={() => setTarget(undefined)}
          onStarted={onOpenLive}
        />
      )}

      <div style={{ marginBottom: 16 }}>
        <MetricStrip
          items={[
            {
              label: delta === undefined ? 'Latest ACT' : `Latest ACT (${delta > 0 ? '+' : ''}${delta} vs prior)`,
              value: latestScore !== undefined ? `${latestScore}/25` : '—',
              tone: latestScore === undefined ? 'brand' : latestScore >= 20 ? 'ok' : latestScore >= 16 ? 'info' : 'urgent',
            },
            { label: 'Draft plans', value: drafts.length, tone: drafts.length ? 'urgent' : 'brand' },
            { label: 'Active plans', value: activePlans.length, tone: 'ok' },
            { label: 'Calls', value: calls.length, tone: 'info' },
          ]}
        />
      </div>

      <div className="grid-review">
        {/* Left rail — identity + at-a-glance numbers */}
        <div className="stack">
          <Card padded>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <Avatar name={name} />
              <div style={{ minWidth: 0 }}>
                <h2 style={{ fontSize: 18 }}>{name}</h2>
                <p className="small muted mono" style={{ marginTop: 3 }}>{patientId}</p>
              </div>
            </div>
            <dl className="kv">
              <div><dt>Date of birth</dt><dd>{patient?.birthDate ?? '—'}</dd></div>
              <div><dt>Phone</dt><dd>{phone ?? 'none on file'}</dd></div>
              {email && <div><dt>Email</dt><dd>{email}</dd></div>}
              <div>
                <dt>Latest ACT</dt>
                <dd style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                  {sparkValues.length >= 2 && (
                    <Sparkline values={sparkValues} tone={latestScore !== undefined && latestScore >= 20 ? 'ok' : 'info'} />
                  )}
                  {latestScore !== undefined ? `${latestScore} / 25` : 'no score yet'}
                </dd>
              </div>
              <div><dt>Record updated</dt><dd>{relativeTime(patient?.meta?.lastUpdated)}</dd></div>
            </dl>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              {drafts.length > 0 && <Badge tone="urgent">{drafts.length} draft plan{drafts.length === 1 ? '' : 's'}</Badge>}
              {activePlans.length > 0 && <Badge tone="ok">{activePlans.length} active</Badge>}
              <Badge tone="info">{calls.length} call{calls.length === 1 ? '' : 's'}</Badge>
            </div>
          </Card>

          <Card title="Calls" subtitle={`${calls.length} recorded`}>
            {calls.length === 0 ? (
              <Empty>No calls recorded for this patient yet.</Empty>
            ) : (
              calls.slice(0, 8).map((call) => (
                <button
                  key={call.id}
                  className="row"
                  onClick={() => onOpenLive(patientId)}
                  title="Open the charting feed"
                >
                  <span className="grow">
                    <span className="name">{call.direction} call</span>
                    <span className="meta">{relativeTime(call.when)}</span>
                  </span>
                  <Badge tone={call.status === 'Completed' ? 'ok' : 'critical'}>
                    {call.status === 'Completed' && Icon.check()}
                    {call.status}
                  </Badge>
                </button>
              ))
            )}
          </Card>
        </div>

        {/* Main column — plans, trend, recent charting */}
        <div className="stack">
          {/* Plans are grouped by what the clinician still owes: anything in
              draft is work, anything approved is the plan actually in force. */}
          <Card title="Care plans" subtitle={plans.length ? `${drafts.length} awaiting review · ${activePlans.length} approved` : undefined}>
            {plans.length === 0 ? (
              <Empty title="No plans yet">
                A draft plan is written within about 15 seconds of a completed check-in call.
              </Empty>
            ) : (
              <>
                {drafts.length > 0 && <div className="day-sep">Awaiting review</div>}
                {drafts.map((plan) => (
                  <button key={plan.id} className="row" onClick={() => onOpenPlan(plan)}>
                    <span className="grow">
                      <span className="name">{plan.title ?? 'Care plan'}</span>
                      <span className="meta">drafted {relativeTime(plan.created)}</span>
                    </span>
                    <Badge tone="urgent">needs review</Badge>
                    <span className="chev">{Icon.arrowRight()}</span>
                  </button>
                ))}

                {activePlans.length > 0 && <div className="day-sep">Approved &amp; in force</div>}
                {activePlans.map((plan) => (
                  <button key={plan.id} className="row" onClick={() => onOpenPlan(plan)}>
                    <span className="grow">
                      <span className="name">{plan.title ?? 'Care plan'}</span>
                      <span className="meta">{approvedLabel(plan) ?? `started ${relativeTime(plan.created)}`}</span>
                    </span>
                    <Badge tone="ok">{Icon.check()} approved</Badge>
                    <span className="chev">{Icon.arrowRight()}</span>
                  </button>
                ))}

                {others.length > 0 && <div className="day-sep">Superseded</div>}
                {others.map((plan) => (
                  <button key={plan.id} className="row" onClick={() => onOpenPlan(plan)}>
                    <span className="grow">
                      <span className="name">{plan.title ?? 'Care plan'}</span>
                      <span className="meta">{relativeTime(plan.created)}</span>
                    </span>
                    <Badge tone="routine">{plan.status}</Badge>
                    <span className="chev">{Icon.arrowRight()}</span>
                  </button>
                ))}
              </>
            )}
          </Card>

          <Card title="Score trend" subtitle="Finalised total scores over time" padded>
            <Trend points={trendPoints} min={0} max={trendMax} higherIsBetter={trendMax <= 25} />
          </Card>

          <Card
            title="Recent charting"
            subtitle={live ? 'Updating live' : `${chartLines.length} entries`}
            action={live ? <Badge tone="live">Live</Badge> : undefined}
          >
            {chartLines.length === 0 ? (
              <Empty>Nothing charted yet. Start a call and this fills in as the patient answers.</Empty>
            ) : (
              chartLines.slice(0, 15).map((line) => (
                <div key={line.id} className="feed-item">
                  <span className="feed-time">{clockTime(line.sent)}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>{communicationText(line)}</span>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
