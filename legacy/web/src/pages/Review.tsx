import type { CarePlan, MedicationRequest } from '@medplum/fhirtypes';
import { useRef, useState } from 'react';
import { approve, unapprove } from '../bridge';
import { CallDialog, type CallTarget } from '../components/CallDialog';
import {
  CATEGORIES,
  byCategory,
  communicationText,
  displayName,
  hasCriticalFlag,
  idFromReference,
  saveMedication,
  savePlanNote,
  useReviewData,
  usePlanSummaries,
  type Priority,
} from '../data';
import { Trend } from '../components/Trend';
import { RxNormSelect } from '../components/RxNormSelect';
import { BandMeter, ItemBreakdown, ScoreTrendChart } from '../clinical/charts';
import { scaleForText } from '../clinical/scale';
import { instrumentMeta, linkIdForLoinc } from '../clinical/items';
import { Avatar, Badge, Card, Chip, Empty, Icon, MetricStrip, Skeleton, clockTime, relativeTime, type Tone } from '../ui';

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, urgent: 1, routine: 2 };

function severityOf(line: string): 'critical' | 'warning' | 'info' {
  const lower = line.toLowerCase();
  if (lower.includes('[critical]')) return 'critical';
  if (lower.includes('[warning]')) return 'warning';
  return 'info';
}

interface PanelReview {
  persona: string;
  specialty?: string;
  stance: string;
  rationale: string;
  edit?: string;
  ran: boolean;
}

/** Parse the stored panel text back into structured per-reviewer cards. */
function parsePanel(text: string): PanelReview[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [head = '', ...rest] = block.split('\n');
      const ran = !/\[did not run\]/i.test(head);
      const clean = head.replace(/\[did not run\]/i, '').trim();
      const m = clean.match(/^(.+?)(?:\s*\((.+?)\))?\s*[—-]\s*(.+)$/);
      const body = rest.join('\n');
      const editIdx = body.indexOf('Suggested edit:');
      return {
        persona: m?.[1]?.trim() ?? clean,
        specialty: m?.[2]?.trim(),
        stance: (m?.[3] ?? '').trim().toLowerCase(),
        rationale: (editIdx >= 0 ? body.slice(0, editIdx) : body).trim(),
        edit: editIdx >= 0 ? body.slice(editIdx + 'Suggested edit:'.length).trim() : undefined,
        ran,
      };
    });
}

function stanceTone(stance: string): Tone {
  if (/reject|block|unsafe/.test(stance)) return 'critical';
  if (/concern|revise|caution/.test(stance)) return 'urgent';
  if (/approve|agree|endorse|ok/.test(stance)) return 'ok';
  return 'info';
}

/**
 * The pipeline writes medication-safety findings and future-risk findings into
 * one artifact. These are the medication-safety screen's own codes, so anything
 * else in the artifact is a risk-rule finding and belongs in its own section —
 * they answer different clinical questions ("is this order safe?" versus "how
 * likely is this patient to deteriorate?").
 */
const SAFETY_CODES = new Set(['allergy-match', 'duplicate-therapy', 'interaction', 'note', 'risk-rules-failed']);

function findingCode(line: string): string {
  return line.replace(/^\[[a-z]+\]\s*/i, '').split(':')[0]?.trim() ?? '';
}

function isSafetyFinding(line: string): boolean {
  return SAFETY_CODES.has(findingCode(line));
}

function findingText(line: string): string {
  const withoutSeverity = line.replace(/^\[[a-z]+\]\s*/i, '');
  const colon = withoutSeverity.indexOf(':');
  return colon >= 0 ? withoutSeverity.slice(colon + 1).trim() : withoutSeverity;
}

function humanCode(code: string): string {
  return code.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function MedicationRow({
  request,
  editable,
  onSaved,
}: {
  request: MedicationRequest;
  editable: boolean;
  onSaved: () => void;
}): JSX.Element {
  const coding = request.medicationCodeableConcept?.coding?.[0];
  const [display, setDisplay] = useState(coding?.display ?? '');
  const [code, setCode] = useState(coding?.code ?? '');
  const [sig, setSig] = useState(request.dosageInstruction?.[0]?.text ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await saveMedication({
        ...request,
        medicationCodeableConcept: {
          coding: [
            { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code, display },
          ],
          text: display,
        },
        dosageInstruction: [{ ...(request.dosageInstruction?.[0] ?? {}), text: sig }],
      });
      setDirty(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (!editable) {
    return (
      <tr>
        <td>
          {display}
          {code && <div className="small muted mono" style={{ marginTop: 3 }}>RxCUI {code}</div>}
        </td>
        <td>{sig}</td>
        <td><Badge tone="ok">{request.status}</Badge></td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        {/* Picking a concept sets the code and the display together, so the
            pair can never drift out of sync the way two free-text fields can. */}
        <RxNormSelect
          value={{ code, display }}
          onChange={(next) => {
            setDisplay(next.display);
            setCode(next.code);
            setDirty(true);
          }}
        />
      </td>
      <td>
        <input aria-label="Directions" value={sig}
          onChange={(e) => { setSig(e.target.value); setDirty(true); }} />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </td>
    </tr>
  );
}

export function ReviewPage({
  plans,
  loading,
  selected,
  onSelect,
  onBack,
  onChanged,
  onOpenLive,
}: {
  plans: CarePlan[];
  loading?: boolean;
  selected?: CarePlan;
  onSelect: (plan: CarePlan) => void;
  onBack?: () => void;
  onChanged: () => void;
  onOpenLive?: (patientId: string) => void;
}): JSX.Element {
  const summaries = usePlanSummaries(plans);
  const [reloadKey, setReloadKey] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const [callTarget, setCallTarget] = useState<CallTarget>();
  const [filter, setFilter] = useState<'all' | Priority>('all');
  // Clinician note: a panel suggestion is *proposed* text, so applying it drops
  // it here for the reviewer to edit and save — it never rewrites an order.
  const [note, setNote] = useState<string>();
  const [savingNote, setSavingNote] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);

  // Worst first, for real — the list is triage-ordered, not recency-ordered.
  const ranked = [...summaries].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const counts = {
    critical: summaries.filter((s) => s.priority === 'critical').length,
    urgent: summaries.filter((s) => s.priority === 'urgent').length,
    routine: summaries.filter((s) => s.priority === 'routine').length,
  };
  const shownSummaries = ranked.filter((s) => filter === 'all' || s.priority === filter);
  const plan = selected ?? ranked[0]?.plan ?? plans[0];

  const { patient, medications, communications, scores, itemAnswers, task } = useReviewData(plan, reloadKey);
  const patientId = idFromReference(plan?.subject?.reference);
  const patientPhone = patient?.telecom?.find((t) => t.system === 'phone')?.value;

  const critical = hasCriticalFlag(communications);
  const isDraft = plan?.status === 'draft';

  const allFindings = byCategory(communications, CATEGORIES.safety)
    .flatMap((c) => communicationText(c).split('\n'))
    .filter((line) => Boolean(line) && !/^no safety or risk findings/i.test(line));
  const safetyLines = allFindings.filter(isSafetyFinding);
  const riskLines = allFindings.filter((line) => !isSafetyFinding(line));
  const concerns = byCategory(communications, CATEGORIES.concern).map(communicationText);
  const research = byCategory(communications, CATEGORIES.research).map(communicationText);
  const panel = byCategory(communications, CATEGORIES.panel);
  const panelText = panel.map(communicationText).join('\n\n');
  const panelReviews = panelText ? parsePanel(panelText) : [];
  const panelConsensus = panel[0]?.topic?.text?.split(/[—-]/).slice(1).join('-').trim().toLowerCase();
  const coverage = byCategory(communications, CATEGORIES.coverage).map(communicationText);
  const recap = byCategory(communications, CATEGORIES.recap).map(communicationText);
  const chart = byCategory(communications, CATEGORIES.chart);

  const trendPoints = scores.map((obs) => ({
    date: obs.effectiveDateTime ?? obs.issued ?? '',
    total: obs.valueQuantity?.value ?? 0,
  }));
  const trendMax = Math.max(25, ...trendPoints.map((p) => p.total));
  const latestScore = trendPoints[trendPoints.length - 1]?.total;

  const scale = scaleForText(plan?.title);
  const meta = instrumentMeta(scale.instrument);

  // Newest answer per question, worst-scoring first — what drove the total.
  const breakdown = (() => {
    if (!meta) return [];
    const newest = new Map<string, number>();
    for (const obs of [...itemAnswers].sort((a, b) =>
      (b.effectiveDateTime ?? '').localeCompare(a.effectiveDateTime ?? ''),
    )) {
      const linkId = linkIdForLoinc(obs.code?.coding?.[0]?.code);
      if (linkId && !newest.has(linkId) && obs.valueInteger !== undefined) {
        newest.set(linkId, obs.valueInteger);
      }
    }
    return meta.items
      .filter((item) => newest.has(item.linkId))
      .map((item) => ({
        linkId: item.linkId,
        label: item.short,
        prompt: `${item.prompt}\n${item.scale}`,
        value: newest.get(item.linkId)!,
        min: item.min,
        max: item.max,
      }))
      .sort((a, b) =>
        meta.higherIsBetter ? a.value - b.value : b.value - a.value,
      );
  })();

  // The note shown is the working copy if the reviewer has started one,
  // otherwise whatever is already on the plan.
  const planNote = plan?.note?.map((n) => n.text).filter(Boolean).join('\n') ?? '';
  const noteValue = note ?? planNote;
  // The bridge stamps the approval into the plan's notes; the latest one wins
  // so a re-approval after a withdrawal shows the newer time.
  const approvedAt = plan?.note
    ?.map((n) => n.text ?? '')
    .filter((t) => /^Approved at /i.test(t))
    .map((t) => t.match(/Approved at (\S+?)(?:\s|\.|$)/)?.[1])
    .filter(Boolean)
    .pop();

  function applySuggestion(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !isDraft) return;
    setNote((current) => {
      const base = (current ?? planNote).trim();
      return base.includes(trimmed) ? base : base ? `${base}\n${trimmed}` : trimmed;
    });
    // The note lives further down the page, so without moving the reader to it
    // the button looks like it did nothing.
    requestAnimationFrame(() => {
      noteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      noteRef.current?.focus({ preventScroll: true });
    });
  }

  /** Already in the note — the button says so rather than silently no-op'ing. */
  function isApplied(text: string): boolean {
    return noteValue.includes(text.trim());
  }

  async function saveNote(): Promise<void> {
    if (!plan || note === undefined) return;
    setSavingNote(true);
    setMessage(undefined);
    try {
      await savePlanNote(plan, note);
      setNote(undefined);
      setReloadKey((k) => k + 1);
      onChanged();
      setMessage({ kind: 'ok', text: 'Clinician note saved to the plan.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Could not save the note.' });
    } finally {
      setSavingNote(false);
    }
  }

  async function onUndoApproval(): Promise<void> {
    if (!plan?.id) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await unapprove({ carePlanId: plan.id });
      if (result.reverted) {
        setMessage({
          kind: 'ok',
          text: 'Approval withdrawn. The plan and its orders are back in draft, and the review task is open again.',
        });
        setReloadKey((k) => k + 1);
        onChanged();
      } else {
        setMessage({ kind: 'error', text: result.reason ?? 'Could not withdraw the approval.' });
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Could not withdraw the approval.' });
    } finally {
      setBusy(false);
      setConfirmUndo(false);
    }
  }

  async function onApprove(): Promise<void> {
    if (!plan?.id) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await approve({
        carePlanId: plan.id,
        hasCriticalFlag: critical,
        acknowledgedCriticalFlags: acknowledged,
      });
      if (result.approved) {
        setMessage({
          kind: 'ok',
          text: 'Approved. The plan and its medications are active, and it now shows under the patient’s approved plans.',
        });
        onChanged();
        // The plan has left the queue — return there so the reviewer sees what
        // is still outstanding rather than a now-approved plan.
        setTimeout(() => onBack?.(), 1400);
      } else {
        setMessage({ kind: 'error', text: result.reason ?? 'Approval was refused.' });
      }
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Approval failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  const patientName = patient ? displayName(patient) : 'Loading…';

  return (
    <>
      <header className="page-head">
        {onBack && (
          <button className="btn ghost" onClick={onBack} aria-label="Back to the review queue">
            {Icon.chevronLeft()} Review queue
          </button>
        )}
        <div style={{ marginLeft: onBack ? 4 : 0 }}>
          <h1>Review</h1>
          <p className="sub">
            {plans.length} draft plan{plans.length === 1 ? '' : 's'} awaiting a clinician.
          </p>
        </div>
      </header>

      {callTarget && (
        <CallDialog
          target={callTarget}
          onClose={() => setCallTarget(undefined)}
          onStarted={(id) => onOpenLive?.(id)}
        />
      )}

      {summaries.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <MetricStrip
            items={[
              { label: 'Awaiting review', value: summaries.length, tone: 'brand' },
              { label: 'Critical', value: counts.critical, tone: counts.critical ? 'critical' : 'routine' },
              { label: 'Urgent', value: counts.urgent, tone: counts.urgent ? 'urgent' : 'routine' },
              { label: 'Routine', value: counts.routine, tone: 'ok' },
            ]}
          />
        </div>
      )}

      <div className="grid-review">
        <Card
          title="Drafts"
          subtitle="Worst first"
          action={
            summaries.length > 0 && (
              <div className="chips">
                <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All {summaries.length}</Chip>
                {counts.critical > 0 && (
                  <Chip active={filter === 'critical'} onClick={() => setFilter('critical')}>Critical {counts.critical}</Chip>
                )}
                {counts.urgent > 0 && (
                  <Chip active={filter === 'urgent'} onClick={() => setFilter('urgent')}>Urgent {counts.urgent}</Chip>
                )}
              </div>
            )
          }
        >
          {loading && summaries.length === 0 ? (
            <Skeleton rows={4} />
          ) : summaries.length === 0 ? (
            <Empty title="Nothing waiting">
              A draft appears here within about 15 seconds of a call ending.
            </Empty>
          ) : shownSummaries.length === 0 ? (
            <Empty>No {filter} plans in the queue.</Empty>
          ) : (
            shownSummaries.map(({ plan: p, name, priority }) => (
              <button
                key={p.id}
                className={`row ${p.id === plan?.id ? 'selected' : ''}`}
                onClick={() => { onSelect(p); setAcknowledged(false); setMessage(undefined); }}
              >
                <Avatar name={name} small />
                <span className="grow">
                  <span className="name">{name}</span>
                  <span className="meta">{relativeTime(p.created)}</span>
                </span>
                <Badge tone={priority}>{priority}</Badge>
              </button>
            ))
          )}
        </Card>

        {!plan ? (
          <Card>
            <Empty title="Select a draft">
              Pick a plan on the left to see its trend, safety flags, evidence and regimen.
            </Empty>
          </Card>
        ) : (
          <div className="stack">
            {/* 1 — summary */}
            <Card padded>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <Avatar name={patientName} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2 style={{ fontSize: 19 }}>{patientName}</h2>
                  <p className="small muted" style={{ marginTop: 3 }}>
                    {patient?.birthDate ? `DOB ${patient.birthDate} · ` : ''}
                    drafted {relativeTime(plan.created)}
                  </p>
                </div>
                <Badge tone={isDraft ? 'routine' : 'ok'}>{plan.status}</Badge>
                {task?.priority === 'urgent' && <Badge tone="urgent">urgent task</Badge>}
              </div>

              {/* The plan is one view of a patient, not an island — these are
                  the other two, so the reviewer never has to navigate by
                  memorising an id. */}
              <dl className="factgrid">
                <div>
                  <dt>Age / sex</dt>
                  <dd>
                    {patient?.birthDate
                      ? `${Math.floor((Date.now() - new Date(patient.birthDate).getTime()) / 31557600000)} yrs`
                      : '—'}
                    {patient?.gender ? ` · ${patient.gender}` : ''}
                  </dd>
                </div>
                <div><dt>Date of birth</dt><dd>{patient?.birthDate ?? '—'}</dd></div>
                <div>
                  <dt>Location</dt>
                  <dd>
                    {[patient?.address?.[0]?.city, patient?.address?.[0]?.state]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </dd>
                </div>
                <div>
                  <dt>Phone</dt>
                  <dd>{patientPhone ?? 'none on file'}</dd>
                </div>
                <div>
                  <dt>Coverage</dt>
                  <dd>{coverage.length > 0 ? (coverage[0]!.match(/Plan:\s*(.+)/)?.[1] ?? 'on file') : '—'}</dd>
                </div>
              </dl>

              <div className="pills" style={{ marginTop: 14 }}>
                {latestScore !== undefined && (
                  <span className="pill">{Icon.trend()} {scale.instrument} {latestScore}/{scale.max}</span>
                )}
                <span className="pill">{medications.length} drafted order{medications.length === 1 ? '' : 's'}</span>
                {safetyLines.length > 0 && (
                  <span className="pill">{safetyLines.length} safety finding{safetyLines.length === 1 ? '' : 's'}</span>
                )}
                {riskLines.length > 0 && (
                  <span className="pill">{riskLines.length} risk factor{riskLines.length === 1 ? '' : 's'}</span>
                )}
                {critical && <Badge tone="critical">critical flag</Badge>}
                {concerns.length > 0 && <span className="pill">{concerns.length} concern{concerns.length === 1 ? '' : 's'}</span>}
              </div>

              {/* The plan is one view of a patient, not an island — these are
                  the other two, so the reviewer never has to navigate by
                  memorising an id. */}
              {patientId && (
                <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={() => onOpenLive?.(patientId)}>
                    {Icon.live()} Charting feed
                  </button>
                  <button
                    className="btn"
                    disabled={!patientPhone}
                    title={patientPhone ? `Call ${patientName}` : 'No phone number on file'}
                    onClick={() => setCallTarget({ patientId, name: patientName, phone: patientPhone })}
                  >
                    {Icon.phone()} Call again
                  </button>
                </div>
              )}
              <p style={{ marginTop: 18, fontWeight: 600 }}>{plan.title}</p>
              <p className="muted" style={{ marginTop: 6 }}>{plan.description}</p>
              {plan.note?.map((note, i) => (
                <p key={i} className="small muted" style={{ marginTop: 8 }}>{note.text}</p>
              ))}
              {plan.replaces?.length ? (
                <p className="small muted" style={{ marginTop: 8 }}>
                  Replaces {plan.replaces.length} previous active plan
                  {plan.replaces.length === 1 ? '' : 's'}.
                </p>
              ) : null}
            </Card>

            {/* 2 — where the score sits, and how it got there */}
            <Card title={scale.instrumentLong} subtitle="Where this score sits on the instrument" padded>
              {latestScore !== undefined ? (
                <>
                  <BandMeter scale={scale} total={latestScore} showTicks />
                  <div style={{ marginTop: 20 }}>
                    <ScoreTrendChart points={trendPoints} scale={scale} />
                  </div>
                </>
              ) : (
                <Trend points={trendPoints} min={0} max={trendMax} higherIsBetter={trendMax <= 25} />
              )}
            </Card>

            {/* 3 — which questions drove the total */}
            {breakdown.length > 0 && (
              <Card
                title={`${scale.instrument} item breakdown`}
                subtitle="Worst-scoring items first — what's driving the total"
                padded
              >
                <ItemBreakdown items={breakdown} />
              </Card>
            )}

            {/* 4 — medication safety */}
            <Card
              title="Medication safety"
              subtitle={`Allergy, duplicate-therapy and interaction screen · ${safetyLines.length} finding${safetyLines.length === 1 ? '' : 's'}`}
            >
              {safetyLines.length === 0 ? (
                <Empty>No medication-safety findings on this regimen.</Empty>
              ) : (
                safetyLines.map((line, i) => (
                  <div key={i} className={`finding ${severityOf(line)}`}>
                    <span className="bar" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <Badge tone={severityOf(line) === 'warning' ? 'urgent' : severityOf(line) === 'critical' ? 'critical' : 'info'}>
                        {severityOf(line)}
                      </Badge>
                      <span style={{ display: 'block', marginTop: 5 }}>{findingText(line)}</span>
                    </span>
                  </div>
                ))
              )}
            </Card>

            {/* 5 — future risk, which the control score alone does not capture */}
            {riskLines.length > 0 && (
              <Card
                title="Future-risk factors"
                subtitle={`Beyond the ${scale.instrument} control score · ${riskLines.length} finding${riskLines.length === 1 ? '' : 's'}`}
              >
                {riskLines.map((line, i) => (
                  <div key={i} className={`finding ${severityOf(line)}`}>
                    <span className="bar" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <Badge tone={severityOf(line) === 'warning' ? 'urgent' : severityOf(line) === 'critical' ? 'critical' : 'info'}>
                        {severityOf(line)}
                      </Badge>
                      <span className="risk-code">{humanCode(findingCode(line))}</span>
                      <span style={{ display: 'block', marginTop: 5 }}>{findingText(line)}</span>
                    </span>
                  </div>
                ))}
              </Card>
            )}

            {/* 4 — regimen */}
            <Card title="Drafted regimen" subtitle="Editable until approved">
              {medications.length === 0 ? (
                <Empty>This protocol step drafts no medication.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr><th>Medication</th><th>Directions</th><th /></tr>
                  </thead>
                  <tbody>
                    {medications.map((request) => (
                      <MedicationRow
                        key={request.id}
                        request={request}
                        editable={isDraft}
                        onSaved={() => setReloadKey((k) => k + 1)}
                      />
                    ))}
                  </tbody>
                </table>
              )}
              <p className="small muted" style={{ padding: '14px 24px 18px' }}>
                RxNorm codes come from the module's seed formulary. Confirm the code before
                approving.
              </p>
            </Card>

            {/* 5 — concerns */}
            {concerns.length > 0 && (
              <Card title="Patient concerns" subtitle="In the patient's own words">
                {concerns.map((text, i) => (
                  <div key={i} className="finding info">
                    <span className="bar" />
                    <span>{text}</span>
                  </div>
                ))}
              </Card>
            )}

            {/* 6 — evidence */}
            <Card title="Evidence" subtitle="Off-call synthesis, grounded in the condition corpus" padded>
              {research.length === 0 ? (
                <Empty>No evidence artifact was written for this plan.</Empty>
              ) : (
                research.map((text, i) => <pre className="artifact" key={i}>{text}</pre>)
              )}
            </Card>

            {/* 7 — peer review */}
            <Card
              title="Expert panel"
              subtitle="Decision support — not a clinical sign-off"
              action={
                panelConsensus && <Badge tone={stanceTone(panelConsensus)}>consensus: {panelConsensus}</Badge>
              }
              padded
            >
              {panelReviews.length === 0 ? (
                <Empty>The expert panel did not run for this plan.</Empty>
              ) : (
                panelReviews.map((review, i) => (
                  <div className="persona" key={i}>
                    <div className="persona-head">
                      <Avatar name={review.persona} small />
                      <span className="who">{review.persona}</span>
                      {review.specialty && <span className="pill">{review.specialty}</span>}
                      <span style={{ flex: 1 }} />
                      <Badge tone={review.ran ? stanceTone(review.stance) : 'routine'}>
                        {review.ran ? review.stance || 'reviewed' : 'did not run'}
                      </Badge>
                    </div>
                    <div className="persona-body">{review.rationale}</div>
                    {review.edit && (
                      <div className="persona-edit">
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <strong>Suggested edit:</strong> {review.edit}
                        </span>
                        {isDraft && (
                          <button
                            className={`btn${isApplied(review.edit) ? ' applied' : ''}`}
                            onClick={() => applySuggestion(review.edit!)}
                            title={
                              isApplied(review.edit)
                                ? 'Already in your clinician note'
                                : 'Add this suggestion to your clinician note'
                            }
                          >
                            {isApplied(review.edit) ? <>{Icon.check()} Applied</> : 'Apply'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
              <p className="small muted" style={{ marginTop: 14 }}>
                These are model personas, not licensed clinicians. You remain the sole approver.
              </p>
            </Card>

            {/* 8 — coverage */}
            {coverage.length > 0 && (
              <Card title="Coverage" subtitle="Eligibility is not a formulary check" padded>
                {coverage.map((text, i) => <pre className="artifact" key={i}>{text}</pre>)}
              </Card>
            )}

            {/* 9 — recap + charting timeline */}
            {recap.length > 0 && (
              <Card title="Patient recap" subtitle="What the patient was told" padded>
                {recap.map((text, i) => <p key={i}>{text}</p>)}
              </Card>
            )}

            {chart.length > 0 && (
              <Card title="Charting timeline" subtitle={`${chart.length} entries written during the call`}>
                {chart.slice(0, 30).map((line) => (
                  <div key={line.id} className="feed-item">
                    <span className="feed-time">{clockTime(line.sent)}</span>
                    <span>{communicationText(line)}</span>
                  </div>
                ))}
              </Card>
            )}

            {/* clinician note — where applied suggestions land */}
            {isDraft && (
              <Card
                title="Clinician note"
                subtitle="Applied suggestions and your own notes, saved onto the plan"
                action={
                  note !== undefined && (
                    <button className="btn primary" onClick={saveNote} disabled={savingNote}>
                      {savingNote ? 'Saving…' : 'Save note'}
                    </button>
                  )
                }
                padded
              >
                <textarea
                  ref={noteRef}
                  rows={4}
                  value={noteValue}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a note for the record, or press Apply on an expert suggestion above."
                  aria-label="Clinician note"
                  style={{ resize: 'vertical', lineHeight: 1.6 }}
                />
                <p className="small muted" style={{ marginTop: 10 }}>
                  Applying a suggestion copies its text here for you to edit — it never changes a
                  drafted order on its own.
                </p>
              </Card>
            )}

            {/* approval */}
            {isDraft && (
              <Card title="Approval" padded>
                {critical && (
                  <div className="ack">
                    <label>
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                      />
                      <span>
                        <strong>This plan has a critical safety flag.</strong> I have reviewed the
                        finding above and accept clinical responsibility for approving this plan.
                      </span>
                    </label>
                  </div>
                )}
                {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
                <button
                  className="btn primary"
                  onClick={onApprove}
                  disabled={busy || (critical && !acknowledged)}
                  style={{ marginTop: message ? 14 : 0 }}
                >
                  {Icon.check()} {busy ? 'Approving…' : 'Approve plan'}
                </button>
                <p className="small muted" style={{ marginTop: 12 }}>
                  Approval sets the CarePlan and every drafted medication to active, and completes
                  the review task.
                </p>
              </Card>
            )}

            {/* Approved plans keep a way back — approval activates real orders,
                so a misclick must be reversible. */}
            {plan.status === 'active' && (
              <Card title="Approved" padded>
                <div className="notice ok" style={{ marginBottom: 14 }}>
                  {Icon.check()} This plan is approved and its medications are active.
                  {approvedAt && <> Approved {relativeTime(approvedAt)}.</>}
                </div>
                {message && <div className={`notice ${message.kind}`} style={{ marginBottom: 14 }}>{message.text}</div>}

                {confirmUndo ? (
                  <div className="ack">
                    <p style={{ fontWeight: 600, marginBottom: 10 }}>
                      Withdraw this approval?
                    </p>
                    <p className="small" style={{ marginBottom: 14 }}>
                      The plan and its {medications.length} order{medications.length === 1 ? '' : 's'} return
                      to draft and the review task reopens. The approval stays in the record as
                      withdrawn — nothing is deleted.
                    </p>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button className="btn" onClick={() => setConfirmUndo(false)} disabled={busy}>
                        Keep approved
                      </button>
                      <button className="btn danger" onClick={onUndoApproval} disabled={busy}>
                        {busy ? 'Withdrawing…' : 'Withdraw approval'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button className="btn" onClick={() => setConfirmUndo(true)} disabled={busy}>
                    Undo approval
                  </button>
                )}
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
