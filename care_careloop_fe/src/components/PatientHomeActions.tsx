import { useQuery } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import { useTranslation } from "react-i18next";

import Page from "@/components/Page";
import { API } from "@/utils/api";

/**
 * Extension point: a link to this patient's CareLoop check-ins, on their page
 * in CARE.
 *
 * Renders **nothing** when the patient has no drafts. An extension point that
 * always draws a box adds clutter to every patient page in the deployment for
 * the benefit of the few who were called.
 *
 * Note: `AppShellOverlay` does not exist in this care_fe revision (spike V4),
 * so there is no global call banner — per-patient surfaces and the queue route
 * are the supported places for this UI.
 */
function PatientHomeActionsInner({
  patient,
  facilityId,
}: {
  patient: { id: string };
  facilityId?: string;
}) {
  const { t } = useTranslation();

  const { data } = useQuery({
    queryKey: ["careloop", "patient-drafts", patient.id, facilityId],
    queryFn: () => API.drafts.list(facilityId as string),
    enabled: Boolean(facilityId),
  });

  const mine = (data?.results ?? []).filter((d) => d.patient_id === patient.id);
  if (mine.length === 0) return null;

  const pending = mine.filter((d) => d.status === "pending_review").length;
  const latest = mine[0];

  return (
    <a
      href={`/careloop?status=pending_review`}
      className="flex items-center gap-2 rounded-md border border-secondary-400 px-3 py-2 text-sm font-medium text-secondary-900 hover:border-primary-400 hover:bg-primary-50"
    >
      <ClipboardList className="size-4 text-primary-700" />
      {pending > 0
        ? t("careloop__patient_action_pending", { count: pending })
        : t("careloop__patient_action_latest", {
            band: latest.band_label,
            score: latest.score_total,
          })}
    </a>
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
