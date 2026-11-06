import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  PhoneOff,
  ShieldAlert,
  Stethoscope,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { API } from "@/utils/api";
import type { DraftListItem, DraftStatus } from "@/types";

/**
 * The clinician's queue.
 *
 * Ordering is the whole design. A reviewer with twenty drafts and ten minutes
 * needs the ones that cannot wait at the top, so rows sort by crisis first,
 * then unacknowledged critical findings, then escalation — not by arrival time.
 * Sorting newest-first would bury the patient who disclosed suicidal ideation
 * under routine check-ins.
 */

const STATUSES: { value: DraftStatus; key: string }[] = [
  { value: "pending_review", key: "careloop__status_pending" },
  { value: "approved", key: "careloop__status_approved" },
  { value: "rejected", key: "careloop__status_rejected" },
];

function urgency(draft: DraftListItem): number {
  if (draft.crisis_override) return 0;
  if (draft.has_critical && !draft.critical_acknowledged) return 1;
  if (draft.escalated) return 2;
  return 3;
}

function Pill({
  tone,
  children,
}: {
  tone: "danger" | "warning" | "primary" | "muted";
  children: React.ReactNode;
}) {
  const tones = {
    danger: "bg-danger-100 text-danger-700 ring-danger-200",
    warning: "bg-warning-100 text-warning-700 ring-warning-200",
    primary: "bg-primary-100 text-primary-700 ring-primary-200",
    muted: "bg-secondary-200 text-secondary-700 ring-secondary-300",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export default function ReviewQueue({ facilityId }: { facilityId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = [
    new URLSearchParams(window.location.search).get("status") ??
      "pending_review",
    (next: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set("status", next);
      window.history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  ] as const;

  const { data, isLoading, error } = useQuery({
    queryKey: ["careloop", "drafts", facilityId, status],
    queryFn: () => API.drafts.list(facilityId, status as DraftStatus),
    // A queue is read while calls are still landing, so it must not go stale
    // in front of someone who is working through it.
    refetchInterval: 30_000,
  });

  const rows = [...(data?.results ?? [])].sort(
    (a, b) => urgency(a) - urgency(b),
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-secondary-900">
          {t("careloop__queue_title")}
        </h1>
        <p className="mt-1 text-sm text-secondary-700">
          {t("careloop__queue_subtitle")}
        </p>
      </header>

      <div className="mb-4 flex gap-2" role="tablist">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            role="tab"
            aria-selected={status === s.value}
            onClick={() => setStatus(s.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              status === s.value
                ? "bg-primary-700 text-white"
                : "bg-secondary-200 text-secondary-800 hover:bg-secondary-300"
            }`}
          >
            {t(s.key)}
          </button>
        ))}
      </div>

      {isLoading && (
        <p className="py-8 text-center text-sm text-secondary-700">
          {t("careloop__loading")}
        </p>
      )}

      {error && (
        <p className="rounded-md bg-danger-50 p-4 text-sm text-danger-700">
          {(error as Error).message}
        </p>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <p className="rounded-md border border-dashed border-secondary-400 py-10 text-center text-sm text-secondary-700">
          {t("careloop__queue_empty")}
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((draft) => (
          <li key={draft.id}>
            <a
              href={`/careloop/draft/${draft.id}`}
              className="flex items-start justify-between gap-4 rounded-lg border border-secondary-400 bg-white p-4 transition hover:border-primary-400 hover:bg-primary-50"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-semibold text-secondary-900">
                    {draft.patient_name}
                  </span>
                  {draft.crisis_override && (
                    <Pill tone="danger">
                      <ShieldAlert className="size-3" />
                      {t("careloop__crisis")}
                    </Pill>
                  )}
                  {draft.has_critical && !draft.critical_acknowledged && (
                    <Pill tone="danger">
                      <AlertTriangle className="size-3" />
                      {t("careloop__needs_acknowledgement")}
                    </Pill>
                  )}
                  {draft.escalated && !draft.crisis_override && (
                    <Pill tone="warning">
                      <ArrowUpRight className="size-3" />
                      {t("careloop__escalated")}
                    </Pill>
                  )}
                  {draft.call_status !== "connected" && (
                    <Pill tone="muted">
                      <PhoneOff className="size-3" />
                      {draft.call_status}
                    </Pill>
                  )}
                </div>
                <p className="mt-1 truncate text-sm text-secondary-700">
                  <Stethoscope className="mr-1 inline size-3.5" />
                  {draft.module_id} · {draft.band_label}
                </p>
              </div>

              <div className="shrink-0 text-right">
                <div className="text-2xl font-bold text-secondary-900">
                  {draft.score_total}
                </div>
                <div className="text-xs text-secondary-600">
                  {new Date(draft.created_date).toLocaleDateString()}
                </div>
              </div>
            </a>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs text-secondary-600">
        {t("careloop__queue_footer")}
      </p>
    </div>
  );
}
