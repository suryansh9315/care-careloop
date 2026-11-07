import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Loader2, PhoneCall } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import Page from "@/components/Page";
import { API } from "@/utils/api";
import type { StartCallResult } from "@/types";

/**
 * Extension point on the patient's page in CARE: see their CareLoop check-ins,
 * and start a new one.
 *
 * Starting a call is on-demand — a clinician picks the patient — which mirrors
 * the previous implementation rather than introducing scheduled cohorts.
 *
 * Renders nothing when this patient has no drafts AND calling is unavailable,
 * so a deployment with no Sarvam credentials does not grow a dead button on
 * every patient page. `AppShellOverlay` does not exist in this care_fe revision
 * (spike V4), so per-patient surfaces and the queue route are the supported
 * homes for this UI.
 */
function PatientHomeActionsInner({
  patient,
  facilityId,
}: {
  patient: { id: string };
  facilityId?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [started, setStarted] = useState<StartCallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: ["careloop", "config"],
    queryFn: () => API.config(),
    staleTime: 5 * 60_000,
  });

  const { data: drafts } = useQuery({
    queryKey: ["careloop", "patient-drafts", patient.id, facilityId],
    queryFn: () => API.drafts.list(facilityId as string),
    enabled: Boolean(facilityId),
  });

  const startCall = useMutation({
    mutationFn: (moduleId: string) =>
      API.startCall(facilityId as string, patient.id, moduleId),
    onSuccess: (result) => {
      setStarted(result);
      setError(null);
      setPicking(false);
      queryClient.invalidateQueries({ queryKey: ["careloop", "drafts"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const mine = (drafts?.results ?? []).filter(
    (d) => d.patient_id === patient.id,
  );
  const pending = mine.filter((d) => d.status === "pending_review").length;
  const canCall = Boolean(config?.calling_available && facilityId);

  if (mine.length === 0 && !canCall) return null;

  return (
    <div className="space-y-2">
      {mine.length > 0 && (
        <a
          href="/careloop?status=pending_review"
          className="flex items-center gap-2 rounded-md border border-secondary-400 px-3 py-2 text-sm font-medium text-secondary-900 hover:border-primary-400 hover:bg-primary-50"
        >
          <ClipboardList className="size-4 text-primary-700" />
          {pending > 0
            ? t("careloop__patient_action_pending", { count: pending })
            : t("careloop__patient_action_latest", {
                band: mine[0].band_label,
                score: mine[0].score_total,
              })}
        </a>
      )}

      {canCall && !started && (
        <>
          {!picking ? (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="flex w-full items-center gap-2 rounded-md border border-secondary-400 px-3 py-2 text-sm font-medium text-secondary-900 hover:border-primary-400 hover:bg-primary-50"
            >
              <PhoneCall className="size-4 text-primary-700" />
              {t("careloop__start_call")}
            </button>
          ) : (
            <div className="rounded-md border border-secondary-400 p-2">
              <p className="mb-1 text-xs text-secondary-700">
                {t("careloop__start_call_pick")}
              </p>
              <div className="flex flex-wrap gap-1">
                {(config?.modules ?? []).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={startCall.isPending}
                    onClick={() => startCall.mutate(m.id)}
                    className="rounded bg-primary-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-primary-800 disabled:opacity-60"
                  >
                    {startCall.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      m.display
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPicking(false)}
                  className="rounded px-2.5 py-1 text-xs text-secondary-700 hover:bg-secondary-200"
                >
                  {t("careloop__cancel")}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Calling is configured per deployment; if it is not, say why rather
          than showing a button that cannot work. */}
      {config && !config.calling_available && mine.length > 0 && (
        <p className="text-xs text-secondary-600">
          {config.sarvam_configured
            ? t("careloop__no_telephony")
            : t("careloop__no_sarvam")}
        </p>
      )}

      {started && (
        <p className="rounded-md bg-primary-50 p-2 text-xs text-primary-800">
          {t("careloop__call_started")}
          {!started.gap_open && ` ${t("careloop__no_gap_note")}`}
        </p>
      )}

      {error && (
        <p className="rounded-md bg-danger-50 p-2 text-xs text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}

export default function PatientHomeActions(props: {
  patient: { id: string };
  facilityId?: string;
  className?: string;
}) {
  return (
    <Page>
      <PatientHomeActionsInner {...props} />
    </Page>
  );
}
