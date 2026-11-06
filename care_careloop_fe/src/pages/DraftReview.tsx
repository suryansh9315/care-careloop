import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Info,
  Loader2,
  ShieldAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { API } from "@/utils/api";
import type {
  ApprovalResult,
  DraftDetail,
  Finding,
  MedicationProposal,
  Severity,
  ValueSetConcept,
} from "@/types";

/**
 * One draft, for a clinician to accept or refuse.
 *
 * The page is ordered by what a reviewer needs to decide, not by what the API
 * returns: findings first (they are what can stop approval), then the answers
 * and the patient's own words, then the proposed therapy, then the transcript
 * so the score can be checked against the conversation it came from.
 *
 * Approval is deliberately awkward in two places. A critical finding has to be
 * acknowledged in its own action, and a medication has to be bound to a real
 * SNOMED product before it will be written. Both could be collapsed into the
 * approve button; neither should be.
 */

const SEVERITY_STYLES: Record<Severity, { box: string; icon: typeof Info }> = {
  critical: { box: "bg-danger-50 text-danger-800 border-danger-300", icon: TriangleAlert },
  warning: { box: "bg-warning-50 text-warning-800 border-warning-300", icon: AlertTriangle },
  info: { box: "bg-secondary-200 text-secondary-800 border-secondary-400", icon: Info },
};

function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-secondary-400 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-secondary-700">
          {title}
        </h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const style = SEVERITY_STYLES[finding.severity] ?? SEVERITY_STYLES.info;
  const Icon = style.icon;
  return (
    <li className={`flex gap-3 rounded-md border p-3 text-sm ${style.box}`}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>
        <p>{finding.message}</p>
        <p className="mt-1 text-xs opacity-70">
          {finding.code}
          {finding.medication ? ` · ${finding.medication}` : ""}
        </p>
      </div>
    </li>
  );
}

function MedicationSearch({
  onPick,
}: {
  onPick: (concept: ValueSetConcept) => void;
}) {
  const { t } = useTranslation();
  const [term, setTerm] = useState("");
  const { data, isFetching } = useQuery({
    queryKey: ["careloop", "medication-search", term],
    queryFn: () => API.medicationSearch(term),
    // CARE's ValueSet expansion hits a terminology server; do not hammer it
    // on every keystroke.
    enabled: term.trim().length >= 3,
    staleTime: 60_000,
  });

  return (
    <div className="mt-2">
      <input
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder={t("careloop__bind_placeholder")}
        className="w-full rounded-md border border-secondary-400 px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none"
      />
      {isFetching && (
        <p className="mt-1 text-xs text-secondary-600">
          {t("careloop__searching")}
        </p>
      )}
      <ul className="mt-1 space-y-1">
        {(data?.results ?? []).map((concept) => (
          <li key={concept.code}>
            <button
              type="button"
              onClick={() => onPick(concept)}
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-primary-50"
            >
              {concept.display}
              <span className="ml-2 text-xs text-secondary-600">
                {concept.code}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProposalCard({
  draftId,
  proposal,
  editable,
}: {
  draftId: string;
  proposal: MedicationProposal;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (body: Parameters<typeof API.drafts.updateProposal>[2]) =>
      API.drafts.updateProposal(draftId, proposal.id, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["careloop", "draft", draftId] }),
  });

  const willBeSkipped = proposal.accepted && !proposal.bound;

  return (
    <li className="rounded-md border border-secondary-400 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-secondary-900">{proposal.display}</p>
          <p className="mt-0.5 text-sm text-secondary-700">{proposal.sig}</p>
          <p className="mt-1 text-xs text-secondary-600">
            {proposal.role} · {proposal.route} · {proposal.frequency}
            {proposal.prn ? ` · ${t("careloop__prn")}` : ""}
          </p>
        </div>
        {editable && (
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ accepted: !proposal.accepted })}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium ${
              proposal.accepted
                ? "bg-primary-700 text-white"
                : "bg-secondary-200 text-secondary-800 hover:bg-secondary-300"
            }`}
          >
            {proposal.accepted
              ? t("careloop__accepted")
              : t("careloop__accept")}
          </button>
        )}
      </div>

      {proposal.bound ? (
        <p className="mt-2 text-xs text-primary-700">
          <Check className="mr-1 inline size-3" />
          {proposal.snomed_display} ({proposal.snomed_code})
        </p>
      ) : (
        editable && (
          <>
            {willBeSkipped && (
              <p className="mt-2 rounded bg-warning-50 p-2 text-xs text-warning-800">
                <AlertTriangle className="mr-1 inline size-3" />
                {t("careloop__unbound_warning")}
              </p>
            )}
            <MedicationSearch
              onPick={(concept) =>
                update.mutate({
                  accepted: true,
                  snomed_code: concept.code,
                  snomed_display: concept.display,
                })
              }
            />
          </>
        )
      )}
    </li>
  );
}

export default function DraftReview({ draftId }: { draftId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rejectReason, setRejectReason] = useState("");
  const [written, setWritten] = useState<ApprovalResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: draft, isLoading } = useQuery<DraftDetail>({
    queryKey: ["careloop", "draft", draftId],
    queryFn: () => API.drafts.get(draftId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["careloop", "draft", draftId] });
    queryClient.invalidateQueries({ queryKey: ["careloop", "drafts"] });
  };

  const acknowledge = useMutation({
    mutationFn: () => API.drafts.acknowledgeCritical(draftId),
    onSuccess: invalidate,
    onError: (e: Error) => setActionError(e.message),
  });

  const approve = useMutation({
    mutationFn: () => API.drafts.approve(draftId),
    onSuccess: (result) => {
      setWritten(result.written);
      setActionError(null);
      invalidate();
    },
    onError: (e: Error) => setActionError(e.message),
  });

  const reject = useMutation({
    mutationFn: () => API.drafts.reject(draftId, rejectReason),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (e: Error) => setActionError(e.message),
  });

  if (isLoading || !draft) {
    return (
      <p className="py-10 text-center text-sm text-secondary-700">
        {t("careloop__loading")}
      </p>
    );
  }

  const findings = [...draft.safety_findings, ...draft.risk_findings];
  const editable = draft.status === "pending_review";

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6">
      <header>
        <a
          href="/careloop"
          className="text-sm text-primary-700 hover:underline"
        >
          ← {t("careloop__back_to_queue")}
        </a>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-secondary-900">
              {draft.patient_name}
            </h1>
            <p className="text-sm text-secondary-700">
              {draft.module_id} · {t("careloop__status")}: {draft.status}
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-secondary-900">
              {draft.score_total}
            </div>
            <div className="text-sm font-medium text-secondary-700">
              {draft.band_label}
            </div>
          </div>
        </div>
      </header>

      {draft.crisis_override && (
        <div className="flex gap-3 rounded-lg border border-danger-300 bg-danger-50 p-4">
          <ShieldAlert className="size-5 shrink-0 text-danger-700" />
          <div className="text-sm text-danger-800">
            <p className="font-bold">{t("careloop__crisis_banner_title")}</p>
            <p className="mt-1">{t("careloop__crisis_banner_body")}</p>
          </div>
        </div>
      )}

      {/* Nothing is in the chart yet. Say so plainly, every time. */}
      {editable && (
        <p className="rounded-md bg-secondary-200 p-3 text-sm text-secondary-800">
          {t("careloop__not_yet_in_chart")}
        </p>
      )}

      {findings.length > 0 && (
        <Section title={t("careloop__findings")}>
          <ul className="space-y-2">
            {findings.map((f, i) => (
              <FindingRow key={`${f.code}-${i}`} finding={f} />
            ))}
          </ul>
          {draft.has_critical && editable && (
            <div className="mt-3">
              {draft.critical_acknowledged ? (
                <p className="text-sm text-primary-700">
                  <Check className="mr-1 inline size-4" />
                  {t("careloop__acknowledged")}
                </p>
              ) : (
                <button
                  type="button"
                  disabled={acknowledge.isPending}
                  onClick={() => acknowledge.mutate()}
                  className="rounded-md bg-danger-600 px-4 py-2 text-sm font-semibold text-white hover:bg-danger-700 disabled:opacity-60"
                >
                  {t("careloop__acknowledge_critical")}
                </button>
              )}
            </div>
          )}
        </Section>
      )}

      <Section title={t("careloop__answers")}>
        <dl className="grid gap-2 sm:grid-cols-2">
          {draft.instrument_answers.map((a) => (
            <div
              key={a.link_id}
              className="flex justify-between rounded bg-secondary-100 px-3 py-1.5 text-sm"
            >
              <dt className="text-secondary-700">{a.link_id}</dt>
              <dd className="font-semibold text-secondary-900">{a.value}</dd>
            </div>
          ))}
        </dl>
        {draft.risk_answers.length > 0 && (
          <dl className="mt-3 space-y-1">
            {draft.risk_answers.map((a) => (
              <div key={a.link_id} className="text-sm">
                <dt className="text-xs text-secondary-600">{a.link_id}</dt>
                {/* The patient's own words, unparsed. The risk rules parse
                    these server-side; showing the raw answer is what lets a
                    clinician check that parsing. */}
                <dd className="text-secondary-900">“{a.value}”</dd>
              </div>
            ))}
          </dl>
        )}
      </Section>

      {draft.concerns.length > 0 && (
        <Section title={t("careloop__concerns")}>
          <ul className="space-y-1 text-sm text-secondary-900">
            {draft.concerns.map((c, i) => (
              <li key={i}>“{c}”</li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title={t("careloop__proposed_therapy")}
        right={
          <span className="text-xs text-secondary-600">
            {t("careloop__follow_up", { days: draft.follow_up_days })}
          </span>
        }
      >
        {draft.medication_proposals.length === 0 ? (
          <p className="text-sm text-secondary-700">
            {t("careloop__no_medication")}
          </p>
        ) : (
          <ul className="space-y-2">
            {draft.medication_proposals.map((p) => (
              <ProposalCard
                key={p.id}
                draftId={draft.id}
                proposal={p}
                editable={editable}
              />
            ))}
          </ul>
        )}
      </Section>

      {draft.transcript.length > 0 && (
        <Section title={t("careloop__transcript")}>
          <ol className="space-y-1.5 text-sm">
            {draft.transcript.map((turn, i) => (
              <li key={i} className="flex gap-2">
                <span
                  className={`shrink-0 text-xs font-semibold uppercase ${
                    turn.role === "agent"
                      ? "text-secondary-600"
                      : "text-primary-700"
                  }`}
                >
                  {turn.role}
                </span>
                <span className="text-secondary-900">{turn.en_text}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {actionError && (
        <p className="rounded-md bg-danger-50 p-3 text-sm text-danger-700">
          {actionError}
        </p>
      )}

      {written && (
        <Section title={t("careloop__written_to_chart")}>
          <ul className="space-y-1 text-sm text-secondary-900">
            <li>{t("careloop__written_encounter")}</li>
            <li>{t("careloop__written_observations")}</li>
            <li>
              {t("careloop__written_medications", {
                count: written.medication_requests.length,
              })}
            </li>
            <li>{t("careloop__written_note")}</li>
          </ul>
          {written.medications_skipped_unbound.length > 0 && (
            <p className="mt-2 rounded bg-warning-50 p-2 text-sm text-warning-800">
              {t("careloop__written_skipped", {
                list: written.medications_skipped_unbound.join(", "),
              })}
            </p>
          )}
        </Section>
      )}

      {editable && (
        <Section title={t("careloop__decision")}>
          <button
            type="button"
            disabled={approve.isPending || draft.blocks_approval}
            onClick={() => approve.mutate()}
            className="w-full rounded-md bg-primary-700 px-4 py-2.5 font-semibold text-white hover:bg-primary-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {approve.isPending ? (
              <Loader2 className="mx-auto size-5 animate-spin" />
            ) : (
              t("careloop__approve")
            )}
          </button>
          {draft.blocks_approval && (
            <p className="mt-2 text-xs text-danger-700">
              {t("careloop__blocked_hint")}
            </p>
          )}

          <div className="mt-4 border-t border-secondary-300 pt-4">
            <label
              htmlFor="careloop-reject-reason"
              className="text-sm font-medium text-secondary-800"
            >
              {t("careloop__reject_reason_label")}
            </label>
            <textarea
              id="careloop-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-secondary-400 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
            />
            <button
              type="button"
              disabled={reject.isPending || !rejectReason.trim()}
              onClick={() => reject.mutate()}
              className="mt-2 rounded-md border border-danger-300 px-4 py-2 text-sm font-medium text-danger-700 hover:bg-danger-50 disabled:opacity-50"
            >
              <X className="mr-1 inline size-4" />
              {t("careloop__reject")}
            </button>
          </div>
        </Section>
      )}

      {!editable && (
        <p className="text-sm text-secondary-700">
          {draft.status === "approved"
            ? t("careloop__approved_by", {
                who: draft.reviewed_by_username ?? "—",
              })
            : t("careloop__rejected_because", {
                reason: draft.rejection_reason,
              })}
        </p>
      )}

      {/* Provenance. A reviewed call must be traceable to the exact agent
          definition that made it, which is why app_version is pinned per
          attempt rather than read from workspace settings. */}
      <footer className="border-t border-secondary-300 pt-3 text-xs text-secondary-600">
        {t("careloop__provenance", {
          app: draft.agent_app_id || "—",
          version: draft.agent_app_version,
          interaction: draft.interaction_id || "—",
        })}
      </footer>
    </div>
  );
}
