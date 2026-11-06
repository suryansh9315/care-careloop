/**
 * Structural mirrors of the backend payloads.
 *
 * Deliberately hand-written rather than generated or imported: the plugin is a
 * separate build, so `care_fe`'s types cannot cross the federation boundary,
 * and the backend's own types are Python. Declaring only the fields this UI
 * actually reads keeps the mirror small enough to stay honest.
 */

export type Severity = "info" | "warning" | "critical";

export type DraftStatus = "pending_review" | "approved" | "rejected";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  medication?: string | null;
}

export interface Band {
  id: string;
  label: string;
  min: number;
  max: number;
}

export interface ModuleSummary {
  id: string;
  display: string;
  instrument: string;
  min_total: number;
  max_total: number;
  direction: "higher-is-better" | "higher-is-worse";
  bands: Band[];
}

export interface CareloopConfig {
  enabled: boolean;
  /** False when Sarvam or telephony is unconfigured, so the UI can say why. */
  calling_available: boolean;
  sarvam_configured: boolean;
  telephony_configured: boolean;
  gap_stale_days_default: number;
  max_call_attempts: number;
  modules: ModuleSummary[];
}

export interface MedicationProposal {
  id: string;
  display: string;
  role: string;
  sig: string;
  route: string;
  frequency: string;
  prn: boolean;
  duration_days: number | null;
  quantity: number | null;
  refills: number | null;
  ingredients: string[];
  /** Bound by the clinician from CARE's SNOMED-backed medication ValueSet. */
  snomed_code: string;
  snomed_display: string;
  accepted: boolean;
  /** An accepted proposal with no bound product is skipped at approval. */
  bound: boolean;
  medication_request_id: string | null;
}

export interface DraftListItem {
  id: string;
  patient_id: string;
  patient_name: string;
  module_id: string;
  score_total: number;
  band: string;
  band_label: string;
  crisis_override: boolean;
  escalated: boolean;
  status: DraftStatus;
  blocks_approval: boolean;
  has_critical: boolean;
  critical_acknowledged: boolean;
  call_status: string;
  created_date: string;
}

export interface InstrumentAnswer {
  link_id: string;
  value: number;
}

export interface RiskAnswer {
  link_id: string;
  value: string;
}

export interface TranscriptTurn {
  role: "agent" | "user";
  en_text: string;
}

export interface DraftDetail extends DraftListItem {
  instrument_answers: InstrumentAnswer[];
  risk_answers: RiskAnswer[];
  concerns: string[];
  protocol_step_id: string;
  follow_up_days: number;
  safety_findings: Finding[];
  risk_findings: Finding[];
  medication_proposals: MedicationProposal[];
  transcript: TranscriptTurn[];
  interaction_id: string;
  /** Pinned per call, so a review is traceable to the exact agent version. */
  agent_app_id: string;
  agent_app_version: number;
  reviewed_by_username: string | null;
  reviewed_at: string | null;
  rejection_reason: string;
  encounter: string | null;
  questionnaire_response_id: string | null;
}

export interface ApprovalResult {
  encounter_id: string;
  questionnaire_response_id: string;
  medication_requests: string[];
  /** Accepted but unbound — reported so the UI can say what was left out. */
  medications_skipped_unbound: string[];
  note_id: string;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** CARE's medication ValueSet expansion result. */
export interface ValueSetConcept {
  code: string;
  display: string;
  system: string;
}
