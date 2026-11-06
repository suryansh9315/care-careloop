import { useState } from 'react';
import { useCalls, usePatientNames, idFromReference, type CallRecord } from '../data';
import { Avatar, Badge, Card, Chip, Empty, Icon, MetricStrip, relativeTime } from '../ui';

type Filter = 'all' | 'completed' | 'failed';

function dayLabel(iso: string): string {
  const day = iso.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  if (!day) return 'Earlier';
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function CallsPage({ onOpenPatient }: { onOpenPatient: (patientId: string) => void }): JSX.Element {
  const calls = useCalls();
  const names = usePatientNames(calls.map((c) => c.patientReference));
  const [filter, setFilter] = useState<Filter>('all');

  const today = new Date().toISOString().slice(0, 10);
  const completed = calls.filter((c) => c.status === 'Completed').length;
  const failed = calls.length - completed;
  const callsToday = calls.filter((c) => c.when.slice(0, 10) === today).length;

  const shown = calls.filter((c) =>
    filter === 'all' ? true : filter === 'completed' ? c.status === 'Completed' : c.status !== 'Completed',
  );

  // Group the filtered calls by calendar day, preserving recency order.
  const groups: Array<{ day: string; items: CallRecord[] }> = [];
  for (const call of shown) {
    const label = dayLabel(call.when);
    const last = groups[groups.length - 1];
    if (last && last.day === label) last.items.push(call);
    else groups.push({ day: label, items: [call] });
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Calls</h1>
          <p className="sub">Every check-in call, most recent first.</p>
        </div>
      </header>

      <div style={{ marginBottom: 16 }}>
        <MetricStrip
          items={[
            { label: 'Total calls', value: calls.length, tone: 'brand' },
            { label: 'Completed', value: completed, tone: 'ok' },
            { label: 'Failed / no-answer', value: failed, tone: failed ? 'urgent' : 'routine' },
            { label: 'Today', value: callsToday, tone: 'info' },
          ]}
        />
      </div>

      <Card
        title="Call log"
        subtitle={`${shown.length} shown`}
        action={
          <div className="chips">
            <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All</Chip>
            <Chip active={filter === 'completed'} onClick={() => setFilter('completed')}>Completed</Chip>
            <Chip active={filter === 'failed'} onClick={() => setFilter('failed')}>Failed</Chip>
          </div>
        }
      >
        {calls.length === 0 ? (
          <Empty title="No calls yet">
            The log fills in the moment a check-in call completes. Start one from New intake or a
            patient's record.
          </Empty>
        ) : shown.length === 0 ? (
          <Empty>No {filter} calls.</Empty>
        ) : (
          groups.map((group) => (
            <div key={group.day}>
              <div className="day-sep">{group.day}</div>
              {group.items.map((call) => {
                const name = names.get(call.patientReference ?? '') ?? 'Unknown patient';
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
                      <span className="meta">{call.direction} · {relativeTime(call.when)}</span>
                    </span>
                    <Badge tone={call.status === 'Completed' ? 'ok' : 'critical'}>
                      {call.status === 'Completed' && Icon.check()}
                      {call.status}
                    </Badge>
                    <span className="chev">{Icon.chevron()}</span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </Card>
    </>
  );
}
