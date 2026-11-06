import type {
  CarePlan,
  Communication,
  MedicationRequest,
  Observation,
  Patient,
  Task,
} from '@medplum/fhirtypes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { medplum } from './medplum';

/**
 * Read models for the clinician workflow.
 *
 * The dashboard reads only what the signed-in clinician needs. Production
 * authorisation must additionally enforce patient/tenant scope and audit every
 * read — Medplum access policies are the right place for that, not this file.
 */

export const CATEGORIES = {
  research: 'careloop-research',
  panel: 'careloop-panel',
  safety: 'careloop-safety',
  coverage: 'careloop-coverage',
  recap: 'careloop-recap',
  chart: 'careloop-chart',
  concern: 'careloop-concern',
  education: 'careloop-education',
  call: 'careloop-call',
} as const;

export type Priority = 'critical' | 'urgent' | 'routine';

export function communicationText(communication: Communication): string {
  return (communication.payload ?? [])
    .map((entry) => entry.contentString ?? '')
    .filter(Boolean)
    .join('\n');
}

export function byCategory(communications: Communication[], category: string): Communication[] {
  return communications.filter((c) => c.category?.some((cat) => cat.text === category));
}

export function displayName(patient: Patient | undefined): string {
  const name = patient?.name?.[0];
  if (!name) return 'Unknown patient';
  return (
    [name.given?.join(' '), name.family].filter(Boolean).join(' ') || name.text || 'Unknown patient'
  );
}

export function idFromReference(reference: string | undefined): string | undefined {
  return reference?.split('/')[1];
}

/** Severity of a plan, derived from its safety artifact and Task priority. */
export function priorityOf(input: {
  safetyText: string;
  taskPriority?: string;
}): Priority {
  const lower = input.safetyText.toLowerCase();
  if (lower.includes('[critical]')) return 'critical';
  if (input.taskPriority === 'urgent') return 'urgent';
  if (lower.includes('[warning]')) return 'urgent';
  return 'routine';
}

// ---------------------------------------------------------------- hooks

export function useDraftPlans(pollMs = 15000): {
  plans: CarePlan[];
  loading: boolean;
  error?: string;
  refresh: () => void;
} {
  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let first = true;
    // First load shows the skeleton; background polls swap the data in quietly,
    // so a plan appearing after a call never requires a manual reload and the
    // page never flashes a loading state at a clinician who is already reading.
    async function load(): Promise<void> {
      try {
        const results = await medplum.searchResources('CarePlan', {
          status: 'draft',
          _sort: '-_lastUpdated',
          _count: '100',
        });
        if (cancelled) return;
        setPlans([...results]);
        setError(undefined);
      } catch (err: unknown) {
        if (!cancelled && first) setError(err instanceof Error ? err.message : 'Could not load plans.');
      } finally {
        if (!cancelled && first) { setLoading(false); first = false; }
      }
    }
    void load();
    const timer = pollMs ? setInterval(load, pollMs) : undefined;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [tick, pollMs]);

  return { plans, loading, error, refresh: useCallback(() => setTick((t) => t + 1), []) };
}

export function usePatients(pollMs = 20000): { patients: Patient[]; refresh: () => void } {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const results = await medplum.searchResources('Patient', { _count: '100', _sort: '-_lastUpdated' });
        if (!cancelled) setPatients([...results]);
      } catch { /* transient — the next tick retries */ }
    }
    void load();
    const timer = pollMs ? setInterval(load, pollMs) : undefined;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [tick, pollMs]);

  return { patients, refresh: useCallback(() => setTick((t) => t + 1), []) };
}

/**
 * Sentinel for a plan whose Patient no longer resolves.
 *
 * A deleted patient leaves its CarePlans behind, and those plans are not work a
 * clinician can do — there is no one to treat. The queue drops them rather than
 * showing a nameless row, which previously read as the app being broken.
 */
export const MISSING_PATIENT = '__missing_patient__';

/** Patient reference → display name, resolved once and cached for the session. */
const nameCache = new Map<string, string>();

export function usePatientNames(references: Array<string | undefined>): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map(nameCache));
  const key = references.filter(Boolean).sort().join(',');

  useEffect(() => {
    let cancelled = false;
    const missing = [...new Set(references.filter((r): r is string => Boolean(r)))].filter(
      (reference) => !nameCache.has(reference),
    );
    if (missing.length === 0) return;

    void Promise.all(
      missing.map(async (reference) => {
        const id = idFromReference(reference);
        if (!id) return;
        try {
          const patient = await medplum.readResource('Patient', id);
          nameCache.set(reference, displayName(patient));
        } catch {
          // The patient record is gone (deleted, or outside this session's
          // scope). Marked distinctly so callers can drop an unactionable row
          // rather than render it as a nameless plan.
          nameCache.set(reference, MISSING_PATIENT);
        }
      }),
    ).then(() => !cancelled && setNames(new Map(nameCache)));

    return () => { cancelled = true; };
  }, [key]);

  return names;
}

export interface CallRecord {
  id: string;
  patientReference?: string;
  when: string;
  status: string;
  direction: string;
}

/** Call log, derived from the charting feed since there is no separate store. */
export function useCalls(pollMs = 15000): CallRecord[] {
  const [calls, setCalls] = useState<CallRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const results = await medplum.searchResources('Communication', {
          category: CATEGORIES.call,
          _sort: '-sent',
          _count: '50',
        });
        if (cancelled) return;
        setCalls(
          [...results].map((communication) => {
            const text = communicationText(communication);
            return {
              id: communication.id ?? '',
              patientReference: communication.subject?.reference,
              when: communication.sent ?? '',
              status: /failed|no-answer|busy/i.test(text) ? 'Failed' : 'Completed',
              direction: /inbound/i.test(text) ? 'Inbound' : 'Outbound',
            };
          }),
        );
      } catch { /* transient — the next tick retries */ }
    }
    void load();
    const timer = pollMs ? setInterval(load, pollMs) : undefined;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [pollMs]);

  return calls;
}

/**
 * Live charting feed for one patient.
 *
 * Seeded with a search so the view is populated before the first push arrives,
 * then kept current by polling. Polling rather than FHIR subscriptions because
 * subscriptions need a project-level WebSocket binding that a read-only
 * clinician session may not have; the feed must degrade to *slower*, never to
 * empty.
 */
export function useLiveFeed(patientId: string | undefined, intervalMs = 3000): {
  observations: Observation[];
  chartLines: Communication[];
  live: boolean;
} {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [chartLines, setChartLines] = useState<Communication[]>([]);
  const [live, setLive] = useState(false);
  const lastSeen = useRef<number>(0);

  useEffect(() => {
    if (!patientId) {
      setObservations([]);
      setChartLines([]);
      setLive(false);
      return;
    }
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        // Sort by _lastUpdated (always server-set) — NOT `sent`, which is
        // absent on legacy artifact rows; those sort first under `-sent` and
        // saturate the _count window, hiding the just-written chart lines.
        // `cache: 'reload'` bypasses the client's 10s GET cache, which would
        // otherwise swallow most polls at this interval.
        const [obs, comms] = await Promise.all([
          medplum.searchResources(
            'Observation',
            {
              subject: `Patient/${patientId}`,
              _sort: '-_lastUpdated',
              _count: '40',
            },
            { cache: 'reload' },
          ),
          medplum.searchResources(
            'Communication',
            {
              subject: `Patient/${patientId}`,
              _sort: '-_lastUpdated',
              _count: '60',
            },
            { cache: 'reload' },
          ),
        ]);
        if (cancelled) return;

        const chart = [...comms].filter((c) =>
          c.category?.some((cat) =>
            [CATEGORIES.chart, CATEGORIES.concern, CATEGORIES.education, CATEGORIES.coverage].includes(
              cat.text as never,
            ),
          ),
        );
        setObservations([...obs]);
        setChartLines(chart);

        // "Live" means something was written in the last 30s — that is what
        // makes the indicator honest rather than decorative.
        const newest = Math.max(
          0,
          ...chart.map((c) => new Date(c.sent ?? c.meta?.lastUpdated ?? 0).getTime()),
          ...obs.map((o) =>
            new Date(o.effectiveDateTime ?? o.issued ?? o.meta?.lastUpdated ?? 0).getTime(),
          ),
        );
        lastSeen.current = newest;
        setLive(Date.now() - newest < 30_000);
      } catch {
        /* transient — the next tick retries */
      }
    }

    void poll();
    const timer = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [patientId, intervalMs]);

  return { observations, chartLines, live };
}

/** Everything the review screen needs for one plan. */
export function useReviewData(plan: CarePlan | undefined, reloadKey = 0): {
  patient?: Patient;
  medications: MedicationRequest[];
  communications: Communication[];
  scores: Observation[];
  itemAnswers: Observation[];
  task?: Task;
  loading: boolean;
} {
  const [patient, setPatient] = useState<Patient>();
  const [medications, setMedications] = useState<MedicationRequest[]>([]);
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [scores, setScores] = useState<Observation[]>([]);
  const [itemAnswers, setItemAnswers] = useState<Observation[]>([]);
  const [task, setTask] = useState<Task>();
  const [loading, setLoading] = useState(false);

  const patientId = idFromReference(plan?.subject?.reference);

  useEffect(() => {
    if (!plan || !patientId) return;
    let cancelled = false;
    setLoading(true);

    const medicationIds = (plan.activity ?? [])
      .map((activity) => activity.reference?.reference)
      .filter((ref): ref is string => Boolean(ref?.startsWith('MedicationRequest/')))
      .map((ref) => ref.split('/')[1])
      .filter((id): id is string => Boolean(id));

    void Promise.all([
      medplum.readResource('Patient', patientId).catch(() => undefined),
      Promise.all(
        medicationIds.map((id) =>
          medplum.readResource('MedicationRequest', id).catch(() => undefined),
        ),
      ),
      medplum.searchResources('Communication', {
        subject: `Patient/${patientId}`,
        _sort: '-sent',
        _count: '100',
      }),
      medplum.searchResources('Observation', {
        subject: `Patient/${patientId}`,
        status: 'final',
        _sort: 'date',
        _count: '60',
      }),
      medplum.searchResources('Task', { focus: `CarePlan/${plan.id}` }).catch(() => []),
    ])
      .then(([p, meds, comms, obs, tasks]) => {
        if (cancelled) return;
        setPatient(p);
        setMedications(meds.filter((m): m is MedicationRequest => Boolean(m)));
        setCommunications([...comms]);
        setScores([...obs].filter((o) => o.valueQuantity?.unit === '{score}'));
        // Per-item answers (valueInteger) drive the "which questions drove the
        // total?" breakdown; only the newest set for each code is relevant.
        setItemAnswers([...obs].filter((o) => o.valueInteger !== undefined));
        setTask(tasks[0]);
      })
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [plan?.id, patientId, reloadKey]);

  return { patient, medications, communications, scores, itemAnswers, task, loading };
}

/** Plan rows enriched with the patient name and triage priority. */
export function usePlanSummaries(plans: CarePlan[]): Array<{
  plan: CarePlan;
  name: string;
  priority: Priority;
}> {
  const references = useMemo(() => plans.map((p) => p.subject?.reference), [plans]);
  const names = usePatientNames(references);
  const [safety, setSafety] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      plans.map(async (plan) => {
        const patientId = idFromReference(plan.subject?.reference);
        if (!patientId || !plan.id) return [plan.id ?? '', ''] as const;
        try {
          const comms = await medplum.searchResources('Communication', {
            subject: `Patient/${patientId}`,
            category: CATEGORIES.safety,
            _sort: '-sent',
            _count: '5',
          });
          return [plan.id, comms.map(communicationText).join('\n')] as const;
        } catch {
          return [plan.id, ''] as const;
        }
      }),
    ).then((entries) => !cancelled && setSafety(new Map(entries)));
    return () => { cancelled = true; };
  }, [plans.map((p) => p.id).join(',')]);

  return plans.map((plan) => ({
    plan,
    name: names.get(plan.subject?.reference ?? '') ?? 'Loading…',
    priority: priorityOf({ safetyText: safety.get(plan.id ?? '') ?? '' }),
  }));
}

/**
 * Every care plan for one patient, newest first.
 *
 * The patient hub needs both drafts and active plans in one place, so unlike
 * `useDraftPlans` this is not filtered by status — the caller decides how to
 * group them.
 */
export function usePatientPlans(patientId: string | undefined): {
  plans: CarePlan[];
  loading: boolean;
} {
  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!patientId) {
      setPlans([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    medplum
      .searchResources('CarePlan', {
        subject: `Patient/${patientId}`,
        _sort: '-_lastUpdated',
        _count: '50',
      })
      .then((results) => !cancelled && setPlans([...results]))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [patientId]);

  return { plans, loading };
}

/**
 * Everything the queue needs to triage one plan, gathered per patient.
 *
 * A FHIR CarePlan carries the narrative but not the clinical facts a reviewer
 * ranks on — the score, the safety counts, the panel verdict, the coverage
 * state. Those live in the artifact Communications and the score Observations,
 * so the queue reads them once here and every consumer (cards, insights,
 * preview) works from the same enriched row.
 */
export interface EnrichedPlan {
  plan: CarePlan;
  patientId?: string;
  name: string;
  scoreTotal?: number;
  priorScores: number[];
  trendPoints: Array<{ date: string; total: number }>;
  safetyCritical: number;
  safetyWarning: number;
  safetyLines: string[];
  consensus?: string;
  panelAgree?: number;
  panelTotal?: number;
  medicationCount: number;
  copayUsd?: number;
  covered?: boolean;
  priorAuthRequired?: boolean;
  recap?: string;
  conditionText?: string;
  loaded: boolean;
  /** The plan's Patient no longer resolves — the row is not actionable. */
  orphaned: boolean;
}

function parseCoverage(text: string): Pick<EnrichedPlan, 'copayUsd' | 'covered' | 'priorAuthRequired'> {
  const copay = text.match(/copay:\s*\$?([\d.]+)/i);
  return {
    copayUsd: copay ? Number(copay[1]) : undefined,
    covered: /covered:\s*true/i.test(text) ? true : /covered:\s*false/i.test(text) ? false : undefined,
    priorAuthRequired: /prior authorisation:\s*true/i.test(text) || /prior authorization:\s*true/i.test(text),
  };
}

export function usePlanQueue(plans: CarePlan[]): { rows: EnrichedPlan[]; loading: boolean } {
  const references = useMemo(() => plans.map((p) => p.subject?.reference), [plans]);
  const names = usePatientNames(references);
  const [byPlan, setByPlan] = useState<Map<string, Partial<EnrichedPlan>>>(new Map());
  const [loading, setLoading] = useState(false);
  const key = plans.map((p) => p.id).join(',');

  useEffect(() => {
    if (plans.length === 0) return;
    let cancelled = false;
    setLoading(true);

    void Promise.all(
      plans.map(async (plan) => {
        const patientId = idFromReference(plan.subject?.reference);
        if (!patientId || !plan.id) return [plan.id ?? '', {}] as const;
        try {
          const [comms, obs] = await Promise.all([
            medplum.searchResources('Communication', {
              subject: `Patient/${patientId}`, _sort: '-sent', _count: '100',
            }),
            medplum.searchResources('Observation', {
              subject: `Patient/${patientId}`, status: 'final', _sort: 'date', _count: '60',
            }),
          ]);

          const safetyLines = byCategory([...comms], CATEGORIES.safety)
            .flatMap((c) => communicationText(c).split('\n'))
            .filter(Boolean);
          const panel = byCategory([...comms], CATEGORIES.panel);
          const panelText = panel.map(communicationText).join('\n\n');
          const coverageText = byCategory([...comms], CATEGORIES.coverage).map(communicationText).join('\n');
          const recap = byCategory([...comms], CATEGORIES.recap).map(communicationText)[0];

          const totals = [...obs]
            .filter((o) => o.valueQuantity?.unit === '{score}')
            .map((o) => ({
              date: o.effectiveDateTime ?? o.issued ?? '',
              total: o.valueQuantity?.value ?? 0,
            }));

          const reviews = panelText.split('\n\n').filter(Boolean);
          const agree = reviews.filter((r) => /—\s*(agree|approve)/i.test(r.split('\n')[0] ?? '')).length;
          const consensusRaw = panel[0]?.topic?.text?.split(/[—-]/).slice(1).join('-').trim().toLowerCase();

          return [
            plan.id,
            {
              patientId,
              scoreTotal: totals[totals.length - 1]?.total,
              priorScores: totals.slice(0, -1).map((t) => t.total),
              trendPoints: totals,
              safetyCritical: safetyLines.filter((l) => /\[critical\]/i.test(l)).length,
              safetyWarning: safetyLines.filter((l) => /\[warning\]/i.test(l)).length,
              safetyLines,
              consensus: consensusRaw || undefined,
              panelAgree: reviews.length ? agree : undefined,
              panelTotal: reviews.length || undefined,
              recap,
              ...parseCoverage(coverageText),
              loaded: true,
            } as Partial<EnrichedPlan>,
          ] as const;
        } catch {
          return [plan.id, {}] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setByPlan(new Map(entries));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [key]);

  const rows = plans.map((plan) => {
    const extra = byPlan.get(plan.id ?? '') ?? {};
    const resolved = names.get(plan.subject?.reference ?? '');
    return {
      plan,
      orphaned: resolved === MISSING_PATIENT,
      name: resolved === MISSING_PATIENT ? 'Patient record unavailable' : resolved ?? 'Loading…',
      conditionText: plan.title,
      medicationCount: (plan.activity ?? []).filter((a) =>
        a.reference?.reference?.startsWith('MedicationRequest/'),
      ).length,
      priorScores: [],
      trendPoints: [],
      safetyCritical: 0,
      safetyWarning: 0,
      safetyLines: [],
      loaded: false,
      ...extra,
    } as EnrichedPlan;
  });

  return { rows, loading };
}

/** Rows a clinician can actually act on, plus how many were dropped and why. */
export function actionableRows(rows: EnrichedPlan[]): { rows: EnrichedPlan[]; orphaned: number } {
  const usable = rows.filter((r) => !r.orphaned);
  return { rows: usable, orphaned: rows.length - usable.length };
}

/**
 * Draft plans a clinician can actually act on.
 *
 * Filtered once, here, rather than in each view — the sidebar badge, the
 * dashboard and the queue previously counted different things (the badge said
 * 11 while the queue showed 7) because only the queue dropped plans whose
 * patient no longer exists. One source, one number.
 *
 * Plans are returned unfiltered until their subjects resolve, so a slow lookup
 * shows the queue rather than an empty screen.
 */
export function useActionablePlans(plans: CarePlan[]): { plans: CarePlan[]; orphaned: number } {
  const references = useMemo(() => plans.map((p) => p.subject?.reference), [plans]);
  const names = usePatientNames(references);
  const usable = plans.filter((p) => names.get(p.subject?.reference ?? '') !== MISSING_PATIENT);
  return { plans: usable, orphaned: plans.length - usable.length };
}

/**
 * Resolve one CarePlan by id, preferring a copy already in hand.
 *
 * A plan reached from a URL is not necessarily in the draft queue — an approved
 * plan opened from the patient hub, or a reloaded deep link, has to be fetched.
 */
export function useCarePlan(id: string | undefined, known: CarePlan[]): CarePlan | undefined {
  const fromList = known.find((p) => p.id === id);
  const [fetched, setFetched] = useState<CarePlan>();

  useEffect(() => {
    if (!id || fromList) return;
    let cancelled = false;
    medplum
      .readResource('CarePlan', id)
      .then((plan) => !cancelled && setFetched(plan))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [id, fromList]);

  if (!id) return undefined;
  return fromList ?? (fetched?.id === id ? fetched : undefined);
}

export async function saveMedication(request: MedicationRequest): Promise<MedicationRequest> {
  return medplum.updateResource(request);
}

/**
 * Persist the clinician's note onto the plan.
 *
 * The note is stored as the plan's own annotation rather than folded into the
 * drafted orders: a panel suggestion is advice, and the record should show that
 * a human wrote this text, separately from what the pipeline proposed.
 */
export async function savePlanNote(plan: CarePlan, text: string): Promise<CarePlan> {
  const trimmed = text.trim();
  return medplum.updateResource({
    ...plan,
    note: trimmed ? [{ text: trimmed, time: new Date().toISOString() }] : undefined,
  });
}

export function hasCriticalFlag(communications: Communication[]): boolean {
  return byCategory(communications, CATEGORIES.safety).some((c) =>
    communicationText(c).toLowerCase().includes('[critical]'),
  );
}
