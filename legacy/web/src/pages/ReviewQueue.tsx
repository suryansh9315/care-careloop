import type { CarePlan } from '@medplum/fhirtypes';
import { useMemo, useState } from 'react';
import { BandMeter, DeltaBadge, ScoreTrendChart, SeverityBar, type Segment } from '../clinical/charts';
import { bandForScore, scaleForText, toneMark, toneVars } from '../clinical/scale';
import { triage, type TriageLevel } from '../clinical/triage';
import { usePlanQueue, type EnrichedPlan } from '../data';
import { Avatar, Badge, Card, Chip, Empty, Icon, MetricStrip, Modal, Skeleton, Sparkline, relativeTime, type Tone } from '../ui';

const CONSENSUS_LABEL: Record<string, string> = {
  revise: 'Revise before approval',
  'approve-with-notes': 'Approve with notes',
  'approve-as-drafted': 'Approve as drafted',
};
const CONSENSUS_TONE: Record<string, Tone> = {
  revise: 'critical',
  'approve-with-notes': 'urgent',
  'approve-as-drafted': 'ok',
};

const LEVEL_TONE: Record<TriageLevel, Tone> = { critical: 'critical', urgent: 'urgent', routine: 'routine' };

/**
 * Triage reasons as glanceable chips.
 *
 * The full sentence stays in the tooltip and the preview; the card carries the
 * shortest phrase that still says which rule fired, so a reviewer scanning the
 * board reads shapes and colour rather than paragraphs.
 */
function shortReason(reason: { code: string; label: string }): string {
  switch (reason.code) {
    case 'safety-critical': return reason.label.replace(/ critical safety flags?/, ' safety');
    case 'peer-revise': return 'panel: revise';
    case 'trend-worsened': return reason.label.replace(/Worsened (\d+) points? since last check-in/, '↓$1 since last');
    case 'coverage': return 'coverage';
    case 'safety-warning': return reason.label.replace(/ safety warnings?/, ' warning');
    default: return reason.label;
  }
}

function flagTone(code: string): string {
  if (code === 'safety-critical' || code === 'score-red-band') return 'critical';
  if (code === 'peer-revise' || code === 'trend-worsened' || code === 'safety-warning' || code === 'score-amber-band') return 'urgent';
  return 'routine';
}

function flagIcon(code: string): JSX.Element {
  if (code === 'safety-critical' || code === 'safety-warning') return Icon.shield();
  if (code === 'peer-revise') return Icon.users();
  if (code === 'trend-worsened') return Icon.trend();
  return Icon.list();
}

type Sort = 'urgent' | 'newest' | 'oldest';

/**
 * Collapse a patient's pending drafts into the one card that represents them.
 *
 * The newest draft is the one a clinician acts on — it is `plan`, so approving
 * still approves a real, whole CarePlan and never a synthesised blend. But the
 * newest draft is not always the most *complete*: a repeat check-in where the
 * patient hung up early can lack the coverage answer or the safety findings an
 * earlier call captured. So every other field takes the newest value that
 * exists, walking back through older drafts to fill a gap rather than dropping
 * what was already collected.
 *
 * Rows that have not finished loading are skipped as sources, so a pending
 * fetch cannot mask a value that is genuinely there.
 */
function mergeDrafts(ordered: EnrichedPlan[]): EnrichedPlan {
  const [newest, ...older] = ordered;
  if (!newest || older.length === 0) return newest!;
  const sources = ordered.filter((r) => r.loaded);

  // First defined value, newest first.
  function pick<K extends keyof EnrichedPlan>(key: K): EnrichedPlan[K] {
    for (const source of sources) {
      const value = source[key];
      if (value !== undefined && value !== null) return value;
    }
    return newest![key];
  }

  return {
    ...newest,
    // Identity and what gets approved always come from the newest draft.
    plan: newest.plan,
    name: newest.name,
    scoreTotal: pick('scoreTotal'),
    trendPoints: pick('trendPoints'),
    priorScores: pick('priorScores'),
    conditionText: pick('conditionText'),
    consensus: pick('consensus'),
    panelAgree: pick('panelAgree'),
    panelTotal: pick('panelTotal'),
    copayUsd: pick('copayUsd'),
    priorAuthRequired: pick('priorAuthRequired'),
    covered: pick('covered'),
    recap: pick('recap'),
    // Findings are a worst-case union: a risk surfaced on any pending draft is
    // still a risk for this patient, so it must not disappear by being on the
    // older one.
    safetyCritical: Math.max(...sources.map((r) => r.safetyCritical ?? 0), newest.safetyCritical ?? 0),
    safetyWarning: Math.max(...sources.map((r) => r.safetyWarning ?? 0), newest.safetyWarning ?? 0),
    loaded: sources.length > 0 ? true : newest.loaded,
  };
}

/** Patients sharing a score collapse to one marker, ascending by score. */
function groupByScore(
  patients: Array<{ name: string; total: number }>,
): Array<{ total: number; names: string[] }> {
  const byTotal = new Map<number, string[]>();
  for (const p of patients) {
    const names = byTotal.get(p.total) ?? [];
    names.push(p.name);
    byTotal.set(p.total, names);
  }
  return [...byTotal.entries()]
    .map(([total, names]) => ({ total, names }))
    .sort((a, b) => a.total - b.total);
}

/**
 * The review queue as a triage board.
 *
 * Every card answers, without a click: how bad is this, why is it flagged,
 * where is the score on the instrument, which way is it moving, and what does
 * the panel think. The ranking is the product — see `clinical/triage.ts`.
 */
export function ReviewQueuePage({
  plans,
  loading,
  orphaned = 0,
  onOpenPlan,
}: {
  plans: CarePlan[];
  loading?: boolean;
  /** Plans excluded upstream because their patient record no longer exists. */
  orphaned?: number;
  onOpenPlan: (plan: CarePlan) => void;
}): JSX.Element {
  const { rows } = usePlanQueue(plans);
  const [filter, setFilter] = useState<'all' | TriageLevel>('all');
  // Newest first by default: the plan that just landed is the one a clinician
  // is usually looking for. Urgency ordering is one click away.
  const [sort, setSort] = useState<Sort>('newest');
  const [preview, setPreview] = useState<EnrichedPlan>();
  const [hoveredDot, setHoveredDot] = useState<string>();
  const [insightsOpen, setInsightsOpen] = useState(false);

  /**
   * One card per patient.
   *
   * Repeat check-ins each write their own draft, so a patient who was called
   * three times filled three slots in the queue with the same clinical picture.
   * Only the newest draft reflects where they actually are, so that is the one
   * shown; the older drafts are counted on the card and approving is still
   * per-plan, so nothing is silently lost.
   */
  const consolidated = useMemo(() => {
    const byPatient = new Map<string, EnrichedPlan[]>();
    for (const row of rows) {
      const key = row.plan.subject?.reference ?? row.plan.id ?? '';
      byPatient.set(key, [...(byPatient.get(key) ?? []), row]);
    }
    return [...byPatient.values()].map((group) => {
      const ordered = [...group].sort((a, b) =>
        (b.plan.created ?? '').localeCompare(a.plan.created ?? ''),
      );
      return { row: mergeDrafts(ordered), superseded: ordered.slice(1) };
    });
  }, [rows]);

  const triaged = useMemo(
    () =>
      consolidated.map(({ row, superseded }) => {
        const scale = scaleForText(row.conditionText ?? row.plan.title);
        return {
          row,
          superseded,
          scale,
          t: triage({
            created: row.plan.created,
            safetyCritical: row.safetyCritical,
            safetyWarning: row.safetyWarning,
            consensus: row.consensus,
            scale,
            scoreTotal: row.scoreTotal,
            priorScores: row.priorScores,
            priorAuthRequired: row.priorAuthRequired,
            covered: row.covered,
          }),
        };
      }),
    [consolidated],
  );

  const counts = {
    critical: triaged.filter((x) => x.t.level === 'critical').length,
    urgent: triaged.filter((x) => x.t.level === 'urgent').length,
    routine: triaged.filter((x) => x.t.level === 'routine').length,
  };

  const shown = triaged
    .filter((x) => filter === 'all' || x.t.level === filter)
    .sort((a, b) =>
      sort === 'urgent'
        ? a.t.rank - b.t.rank
        : sort === 'newest'
          ? (b.row.plan.created ?? '').localeCompare(a.row.plan.created ?? '')
          : (a.row.plan.created ?? '').localeCompare(b.row.plan.created ?? ''),
    );

  // Aggregate visuals — each instrument keeps its own scale, never merged.
  const instrumentGroups = useMemo(() => {
    const map = new Map<string, Array<{ name: string; total: number }>>();
    for (const { row, scale } of triaged) {
      if (row.scoreTotal == null) continue;
      const list = map.get(scale.instrument) ?? [];
      list.push({ name: row.name, total: row.scoreTotal });
      map.set(scale.instrument, list);
    }
    return [...map.entries()].map(([instrument, patients]) => ({
      scale: triaged.find((x) => x.scale.instrument === instrument)!.scale,
      patients,
    }));
  }, [triaged]);

  const consensusSegments: Segment[] = useMemo(() => {
    const map = new Map<string, number>();
    for (const { row } of triaged) if (row.consensus) map.set(row.consensus, (map.get(row.consensus) ?? 0) + 1);
    return ['approve-as-drafted', 'approve-with-notes', 'revise']
      .filter((k) => map.has(k))
      .map((k) => ({
        key: k,
        label: CONSENSUS_LABEL[k] ?? k,
        count: map.get(k)!,
        tone: k === 'revise' ? 'red' : k === 'approve-with-notes' ? 'amber' : 'green',
      }));
  }, [triaged]);

  const criticalFlags = triaged.reduce((s, x) => s + x.row.safetyCritical, 0);
  const coverageBlocked = triaged.filter((x) => x.row.priorAuthRequired || x.row.covered === false).length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Review queue</h1>
          <p className="sub">
            {triaged.length} patient{triaged.length === 1 ? '' : 's'} awaiting clinician sign-off
            {rows.length !== triaged.length && ` · ${rows.length} pending drafts`}.
            {orphaned > 0 && (
              <>
                {' '}
                <span title="These plans reference a patient record that no longer exists, so there is nobody to review them for.">
                  {orphaned} hidden — patient record unavailable.
                </span>
              </>
            )}
          </p>
        </div>
      </header>

      <div style={{ marginBottom: 16 }}>
        <MetricStrip
          items={[
            { label: 'Awaiting review', value: triaged.length, tone: 'brand' },
            { label: 'Critical', value: counts.critical, tone: counts.critical ? 'critical' : 'routine' },
            { label: 'Urgent', value: counts.urgent, tone: counts.urgent ? 'urgent' : 'routine' },
            { label: 'Routine', value: counts.routine, tone: 'ok' },
          ]}
        />
      </div>

      {/* Queue at a glance — the whole panel, per instrument. Collapsed by
          default: the board below is the job, this is the context you open when
          you want it. */}
      {instrumentGroups.length > 0 && insightsOpen && (
        <Card title="Queue at a glance" subtitle="Clinical picture across every draft plan" padded>
          {instrumentGroups.map(({ scale, patients }) => {
            const span = scale.max - scale.min || 1;
            return (
              <div key={scale.instrument} style={{ marginBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 9 }}>
                  <strong style={{ fontSize: 14 }}>{scale.instrumentLong}</strong>
                  <span className="muted small">({scale.instrument})</span>
                  <span style={{ flex: 1 }} />
                  <span className="muted small">{patients.length} patient{patients.length === 1 ? '' : 's'}</span>
                </div>
                <div className="qi-track">
                  {scale.bands.map((b) => (
                    <span
                      key={b.id}
                      className="qi-band"
                      style={{ width: `${((b.max - b.min + 1) / (span + 1)) * 100}%`, background: toneVars(b.tone).bg }}
                    />
                  ))}
                  {/* Patients on the same score sit at the same point, so they
                      are drawn as one marker carrying the count — stacking them
                      invisibly hid everyone but the last. */}
                  {groupByScore(patients).map(({ total, names }) => {
                    const key = `${scale.instrument}-${total}`;
                    const pct = ((total - scale.min) / span) * 100;
                    const band = bandForScore(scale, total);
                    return (
                      <span
                        key={key}
                        className={`qi-dot${hoveredDot === key ? ' active' : ''}${names.length > 1 ? ' multi' : ''}`}
                        style={{ left: `${pct}%` }}
                        tabIndex={0}
                        role="img"
                        aria-label={`${scale.instrument} ${total} — ${band.label}: ${names.join(', ')}`}
                        onMouseEnter={() => setHoveredDot(key)}
                        onMouseLeave={() => setHoveredDot((c) => (c === key ? undefined : c))}
                        onFocus={() => setHoveredDot(key)}
                        onBlur={() => setHoveredDot((c) => (c === key ? undefined : c))}
                      >
                        {names.length > 1 && <span className="qi-dot-n">{names.length}</span>}
                        {hoveredDot === key && (
                          // Anchored above the track so it never covers the legend
                          // underneath, and flipped inward at the extremes.
                          <span
                            className="qi-tip"
                            style={pct > 70 ? { right: 0, transform: 'none' } : pct < 30 ? { left: 0, transform: 'none' } : undefined}
                          >
                            <strong>{scale.instrument} {total}</strong>
                            {` — ${band.label}`}
                            <span className="qi-tip-names">{names.join(', ')}</span>
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
                <div className="sevbar-legend" style={{ marginTop: 9 }}>
                  {scale.bands.map((b) => (
                    <span key={b.id} className="sevbar-legend-item">
                      <i style={{ background: toneMark(b.tone) }} />{b.label}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="qi-secondary">
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 9 }}>
                <strong style={{ fontSize: 14 }}>Expert consensus</strong>
                <span style={{ flex: 1 }} />
                <span className="muted small">peer panel</span>
              </div>
              {consensusSegments.length === 0 ? (
                <p className="small muted">No peer review on file yet.</p>
              ) : (
                <SeverityBar segments={consensusSegments} />
              )}
            </div>
            <div className="qi-metrics">
              <div><span className="qm-v">{criticalFlags}</span><span className="qm-l">Critical flags</span></div>
              <div><span className="qm-v">{coverageBlocked}</span><span className="qm-l">Coverage blocked</span></div>
              <div><span className="qm-v">{counts.critical + counts.urgent}</span><span className="qm-l">Need attention</span></div>
            </div>
          </div>
        </Card>
      )}

      {/* Filters + sort */}
      <div className="queue-controls">
        <div className="chips">
          <span className="small muted">Show</span>
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All ({triaged.length})</Chip>
          <Chip active={filter === 'critical'} onClick={() => setFilter('critical')}>Critical ({counts.critical})</Chip>
          <Chip active={filter === 'urgent'} onClick={() => setFilter('urgent')}>Urgent ({counts.urgent})</Chip>
          <Chip active={filter === 'routine'} onClick={() => setFilter('routine')}>Routine ({counts.routine})</Chip>
        </div>
        <div style={{ flex: 1 }} />
        {instrumentGroups.length > 0 && (
          <Chip active={insightsOpen} onClick={() => setInsightsOpen((o) => !o)}>
            {Icon.trend()} {insightsOpen ? 'Hide' : 'Queue insights'}
          </Chip>
        )}
        <label className="sort-field">
          <span className="small muted">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort the queue">
            <option value="newest">Newest first</option>
            <option value="urgent">Most urgent first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>

      {loading && rows.length === 0 ? (
        <Card><Skeleton rows={4} /></Card>
      ) : rows.length === 0 ? (
        <Card>
          <Empty title="Queue is clear">
            A draft plan appears here within about 15 seconds of a check-in call ending.
          </Empty>
        </Card>
      ) : shown.length === 0 ? (
        <Card><Empty>No {filter} plans in the queue.</Empty></Card>
      ) : (
        <div className="queue-grid">
          {shown.map(({ row, superseded, scale, t }) => {
            const band = row.scoreTotal != null ? bandForScore(scale, row.scoreTotal) : undefined;
            return (
              <article key={row.plan.id} className={`qcard ${t.level}`}>
                <header className="qcard-head">
                  <Avatar name={row.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3>{row.name}</h3>
                    <p className="small muted">{row.plan.title ?? 'Care plan'}</p>
                  </div>
                  <Badge tone={LEVEL_TONE[t.level]}>{t.level}</Badge>
                </header>

                {/* Older pending drafts from earlier check-ins. Disclosed, not
                    hidden: each is still its own plan and still needs a
                    decision — this card just leads with the current one. */}
                {superseded.length > 0 && (
                  <p
                    className="qcard-super"
                    title={
                      `Approving acts on the newest draft. Earlier pending drafts:\n` +
                      superseded
                        .map((s) => `· ${s.plan.title ?? 'Care plan'} — ${relativeTime(s.plan.created)}`)
                        .join('\n')
                    }
                  >
                    {Icon.list()} Newest of {superseded.length + 1} pending · earlier check-ins merged in
                  </p>
                )}

                {/* The score reads as a figure, with the meter placing it on
                    the instrument and the delta showing direction — no prose. */}
                {row.scoreTotal != null && band && (
                  <div className="qcard-score">
                    <div className="qcard-score-num" style={{ color: toneVars(band.tone).ink }}>
                      {row.scoreTotal}
                      <span className="qcard-score-max">/{scale.max}</span>
                    </div>
                    <div className="qcard-score-side">
                      <div className="qcard-score-band" style={{ color: toneVars(band.tone).ink }}>
                        {band.label}
                      </div>
                      {row.trendPoints.length > 1 && (
                        <DeltaBadge points={row.trendPoints} scale={scale} />
                      )}
                    </div>
                    {row.trendPoints.length > 1 && (
                      <Sparkline
                        values={row.trendPoints.map((p) => p.total)}
                        width={92}
                        height={34}
                        tone={band.tone === 'red' ? 'critical' : band.tone === 'amber' ? 'urgent' : 'ok'}
                      />
                    )}
                  </div>
                )}
                {row.scoreTotal == null && (
                  <p className="qcard-noscore">
                    {row.loaded ? 'No score recorded for this plan yet.' : 'Loading score…'}
                  </p>
                )}

                {/* One reason — the single thing that put this at this rank.
                    Everything else is a click away in Preview, so the board can
                    be scanned rather than read. */}
                {t.reasons[0] && (
                  <div className="qcard-flags">
                    <span className={`flag ${flagTone(t.reasons[0].code)}`} title={t.reasons[0].label}>
                      {flagIcon(t.reasons[0].code)} {shortReason(t.reasons[0])}
                    </span>
                    {t.reasons.length > 1 && (
                      <span className="flag more" title={t.reasons.slice(1).map((r) => r.label).join('\n')}>
                        +{t.reasons.length - 1}
                      </span>
                    )}
                  </div>
                )}

                <footer className="qcard-foot">
                  <span className="small muted">{relativeTime(row.plan.created)}</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn" onClick={() => setPreview(row)}>Preview</button>
                  <button className="btn primary" onClick={() => onOpenPlan(row.plan)}>
                    Review {Icon.arrowRight()}
                  </button>
                </footer>
                {band && <span className="qcard-edge" style={{ background: toneMark(band.tone) }} />}
              </article>
            );
          })}
        </div>
      )}

      {preview && (
        <PreviewModal
          row={preview}
          onClose={() => setPreview(undefined)}
          onOpen={() => { onOpenPlan(preview.plan); setPreview(undefined); }}
        />
      )}
    </>
  );
}

function PreviewModal({
  row,
  onClose,
  onOpen,
}: {
  row: EnrichedPlan;
  onClose: () => void;
  onOpen: () => void;
}): JSX.Element {
  const scale = scaleForText(row.conditionText ?? row.plan.title);
  const t = triage({
    created: row.plan.created,
    safetyCritical: row.safetyCritical,
    safetyWarning: row.safetyWarning,
    consensus: row.consensus,
    scale,
    scoreTotal: row.scoreTotal,
    priorScores: row.priorScores,
    priorAuthRequired: row.priorAuthRequired,
    covered: row.covered,
  });

  return (
    <Modal
      title={row.name}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={onOpen}>Open full review {Icon.arrowRight()}</button>
        </>
      }
    >
      <p className="small muted" style={{ marginBottom: 16 }}>{row.plan.title}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <Badge tone={LEVEL_TONE[t.level]}>{t.level}</Badge>
        <strong style={{ fontSize: 14 }}>Why this plan needs attention</strong>
      </div>
      <ul className="qcard-reasons" style={{ marginBottom: 18 }}>
        {t.reasons.map((r) => <li key={r.code}>{r.label}</li>)}
        {t.reasons.length === 0 && <li className="muted">No flags — routine review.</li>}
      </ul>

      {row.scoreTotal != null && (
        <>
          <strong style={{ fontSize: 14 }}>{scale.instrumentLong}</strong>
          <div style={{ margin: '10px 0 18px' }}>
            <BandMeter scale={scale} total={row.scoreTotal} showTicks />
          </div>
        </>
      )}

      {/* The numbers the card deliberately leaves off. */}
      <div className="qcard-icons" style={{ marginTop: 0, marginBottom: 18 }}>
        <span title={`${row.medicationCount} medication${row.medicationCount === 1 ? '' : 's'} drafted`}>
          {Icon.clipboard()} {row.medicationCount} drafted
        </span>
        <span title={row.panelTotal ? `${row.panelAgree ?? 0} of ${row.panelTotal} experts agree` : 'No expert panel'}>
          {Icon.users()} {row.panelTotal ? `${row.panelAgree ?? 0}/${row.panelTotal} agree` : 'no panel'}
        </span>
        <span title={row.copayUsd != null ? `Estimated copay $${row.copayUsd}` : 'Copay unknown'}>
          {Icon.shield()} {row.copayUsd != null ? `$${row.copayUsd}` : '—'}
        </span>
        {row.priorAuthRequired && <span className="pa" title="Prior authorisation required">PA</span>}
        {row.consensus && (
          <span style={{ marginLeft: 'auto' }}>
            <Badge tone={CONSENSUS_TONE[row.consensus] ?? 'info'}>
              {CONSENSUS_LABEL[row.consensus] ?? row.consensus}
            </Badge>
          </span>
        )}
      </div>

      {row.trendPoints.length > 1 && (
        <div style={{ marginBottom: 18 }}>
          <ScoreTrendChart points={row.trendPoints} scale={scale} height={180} />
        </div>
      )}

      {row.safetyLines.length > 0 && (
        <>
          <strong style={{ fontSize: 14 }}>Safety &amp; risk</strong>
          <div style={{ marginTop: 8 }}>
            {row.safetyLines.slice(0, 4).map((line, i) => (
              <p key={i} className="small" style={{ marginTop: 6 }}>{line.replace(/^\[[a-z]+\]\s*/i, '')}</p>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
