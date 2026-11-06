import type { CarePlan, Patient } from '@medplum/fhirtypes';
import type { Route } from '../App';
import {
  communicationText,
  displayName,
  idFromReference,
  useCalls,
  useLiveFeed,
  usePatientNames,
  usePlanSummaries,
  type Priority,
} from '../data';
import { Avatar, Badge, Card, Chip, Empty, Icon, Skeleton, Stat, clockTime, relativeTime } from '../ui';

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, urgent: 1, routine: 2 };

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function DashboardPage({
  plans,
  loading,
  patients,
  onOpenPlan,
  onOpenPatient,
  onNavigate,
}: {
  plans: CarePlan[];
  loading?: boolean;
  patients: Patient[];
  onOpenPlan: (plan: CarePlan) => void;
  onOpenPatient: (patientId: string) => void;
  onNavigate: (route: Route) => void;
}): JSX.Element {
  const summaries = usePlanSummaries(plans);
  const calls = useCalls();
  const callNames = usePatientNames(calls.map((c) => c.patientReference));
  // Live charting for the most recently touched patient, so the dashboard shows
  // documentation writing itself the moment a call is in progress.
  const watched = patients[0];
  const { live, chartLines } = useLiveFeed(watched?.id, 5000);

  const counts = {
    critical: summaries.filter((s) => s.priority === 'critical').length,
    urgent: summaries.filter((s) => s.priority === 'urgent').length,
    routine: summaries.filter((s) => s.priority === 'routine').length,
  };
  const needsAttention = counts.critical + counts.urgent;
  const total = Math.max(summaries.length, 1);

  const ranked = [...summaries].sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  );

  const today = new Date().toISOString().slice(0, 10);
  const callsToday = calls.filter((c) => c.when.slice(0, 10) === today).length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{greeting()}</h1>
          <p className="sub">
            {plans.length === 0
              ? 'Nothing is waiting for review.'
              : `${plans.length} draft plan${plans.length === 1 ? '' : 's'} awaiting review.`}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => onNavigate('intake')}>
          {Icon.plus()} New intake
        </button>
      </header>

      <div className="chips" style={{ marginBottom: 18 }}>
        <span className="small muted" style={{ marginRight: 2 }}>Jump to</span>
        <Chip onClick={() => onNavigate('review')}>
          {Icon.list()} Review queue{plans.length > 0 && <span className="count">· {plans.length}</span>}
        </Chip>
        <Chip onClick={() => onNavigate('live')}>{Icon.live()} Live</Chip>
        <Chip onClick={() => onNavigate('calls')}>{Icon.phone()} Calls</Chip>
        <Chip onClick={() => onNavigate('patients')}>{Icon.users()} Patients</Chip>
        <Chip onClick={() => onNavigate('treatments')}>{Icon.clipboard()} Treatments</Chip>
      </div>

      <div className="grid-3">
        <Stat
          icon={Icon.inbox()}
          value={plans.length}
          label="Draft plans"
          sub="in the queue"
          tone="brand"
          onClick={() => onNavigate('review')}
        />
        <Stat
          icon={Icon.phone()}
          value={callsToday}
          label="Calls today"
          sub={`${calls.length} total`}
          tone="info"
          onClick={() => onNavigate('calls')}
        />
        <Stat
          icon={Icon.users()}
          value={patients.length}
          label="Patients"
          sub="in your workspace"
          tone="ok"
          onClick={() => onNavigate('patients')}
        />
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <Card padded>
          <div
            className="stat-icon"
            style={{
              background: needsAttention > 0 ? 'var(--critical-bg)' : 'var(--ok-bg)',
              color: needsAttention > 0 ? 'var(--critical)' : 'var(--ok)',
            }}
          >
            {Icon.shield()}
          </div>
          <div className="stat-value">{needsAttention}</div>
          <div className="stat-label">
            {needsAttention === 1 ? 'patient needs' : 'patients need'} your attention now
          </div>

          <div className="triage-bar" role="img" aria-label={`${counts.critical} critical, ${counts.urgent} urgent, ${counts.routine} routine`}>
            {counts.critical > 0 && (
              <i className="critical" style={{ width: `${(counts.critical / total) * 100}%` }} />
            )}
            {counts.urgent > 0 && (
              <i className="urgent" style={{ width: `${(counts.urgent / total) * 100}%` }} />
            )}
            {counts.routine > 0 && (
              <i className="routine" style={{ width: `${(counts.routine / total) * 100}%` }} />
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="critical">{counts.critical} critical</Badge>
            <Badge tone="urgent">{counts.urgent} urgent</Badge>
            <Badge tone="routine">{counts.routine} routine</Badge>
          </div>
        </Card>

        <Card
          title="Live charting"
          subtitle={
            live
              ? `Documenting ${watched ? displayName(watched) : 'a call'} now`
              : 'Documentation appears here during a call'
          }
          action={live ? <Badge tone="live">Live</Badge> : <Badge tone="routine">Idle</Badge>}
        >
          {chartLines.length === 0 ? (
            <Empty title={live ? 'Listening…' : 'Nothing charting right now'}>
              When a check-in call is in progress, each answer is written to the record here in real
              time. <button className="link" onClick={() => onNavigate('intake')}>Start a check-in →</button>
            </Empty>
          ) : (
            <>
              {chartLines.slice(0, 6).map((line) => (
                <div key={line.id} className="feed-item">
                  <span className="feed-time">{clockTime(line.sent)}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>{communicationText(line)}</span>
                </div>
              ))}
              <div style={{ padding: '12px 24px' }}>
                <button className="link" onClick={() => onNavigate('live')}>Open the live feed →</button>
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <Card
          title="Needs your attention"
          subtitle="Most urgent first"
          action={
            <button className="link" onClick={() => onNavigate('review')}>
              View all
            </button>
          }
        >
          {loading && ranked.length === 0 ? (
            <Skeleton rows={4} />
          ) : ranked.length === 0 ? (
            <Empty title="Queue is clear">
              Draft plans appear here within about 15 seconds of a call ending.
            </Empty>
          ) : (
            ranked.slice(0, 5).map(({ plan, name, priority }) => (
              <button key={plan.id} className="row" onClick={() => onOpenPlan(plan)}>
                <Avatar name={name} />
                <span className="grow">
                  <span className="name">{name}</span>
                  <span className="meta">{plan.title ?? 'Care plan'}</span>
                </span>
                <Badge tone={priority}>{priority}</Badge>
                <span className="chev">{Icon.arrowRight()}</span>
              </button>
            ))
          )}
        </Card>

        <Card
          title="Recent calls"
          action={
            <button className="link" onClick={() => onNavigate('calls')}>
              View all
            </button>
          }
        >
          {calls.length === 0 ? (
            <Empty title="No calls yet">
              Start one from New intake or the Patients directory.
            </Empty>
          ) : (
            calls.slice(0, 5).map((call) => {
              const name = callNames.get(call.patientReference ?? '') ?? 'Unknown patient';
              const patientId = idFromReference(call.patientReference);
              return (
                <button
                  key={call.id}
                  className="row"
                  onClick={() => patientId && onOpenPatient(patientId)}
                  title={`Open ${name}'s record`}
                >
                  <Avatar name={name} small />
                  <span className="grow">
                    <span className="name">{name}</span>
                    <span className="meta">{call.direction}</span>
                  </span>
                  <Badge tone={call.status === 'Completed' ? 'ok' : 'critical'}>
                    {call.status === 'Completed' && Icon.check()}
                    {call.status}
                  </Badge>
                  <span className="small muted" style={{ marginLeft: 10 }}>
                    {relativeTime(call.when)}
                  </span>
                  <span className="chev">{Icon.arrowRight()}</span>
                </button>
              );
            })
          )}
        </Card>
      </div>
    </>
  );
}
