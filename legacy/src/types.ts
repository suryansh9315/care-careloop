/**
 * Shared domain vocabulary for CareLoop.
 *
 * These types are deliberately independent of FHIR: the deterministic core
 * (scoring, protocol selection, safety) reasons over them, and only the
 * Medplum layer translates them into FHIR resources.
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface CoverageInfo {
  /** Stedi trading-partner / payer ID. */
  payerId: string;
  payerName?: string;
  memberId: string;
  subscriberFirstName?: string;
  subscriberLastName?: string;
  /** YYYY-MM-DD. */
  subscriberDob?: string;
}

export interface MedicationSummary {
  display: string;
  rxnormCode?: string;
  /** Lower-cased tokens used by the deterministic duplicate/interaction check. */
  ingredients?: string[];
}

export interface ScoreHistoryEntry {
  /** ISO date the instrument was completed. */
  date: string;
  total: number;
  band: string;
}

export interface PatientContext {
  patientId: string;
  fullName: string;
  /** YYYY-MM-DD. Used only for identity verification during the call. */
  birthDate?: string;
  phone?: string;
  conditionId?: string;
  conditionDisplay?: string;
  moduleId: string;
  currentMedications: MedicationSummary[];
  allergies: string[];
  triggers: string[];
  /** Oldest to newest. */
  priorScores: ScoreHistoryEntry[];
  coverage?: CoverageInfo;
  /** True when any part of the context came from a mock rather than Medplum. */
  mock: boolean;
}

export interface InstrumentAnswer {
  linkId: string;
  value: number;
}

export interface RiskAnswer {
  linkId: string;
  /** Supplemental future-risk questions are yes/no or short free text. */
  value: string;
}

export interface Concern {
  text: string;
  recordedAt: string;
}

export interface ScoreResult {
  total: number;
  band: string;
  bandLabel: string;
  /** True when a crisis item (e.g. PHQ-9 item 9) overrides the band. */
  crisisOverride: boolean;
}

export type MedRole = 'controller' | 'reliever' | 'primary' | 'adjunct';

export interface MedOrder {
  display: string;
  rxnormCode: string;
  role: MedRole;
  sig: string;
  route: string;
  frequency: string;
  prn: boolean;
  durationDays?: number;
  quantity?: number;
  refills?: number;
  ingredients?: string[];
}

export interface ProtocolStep {
  id: string;
  summary: string;
  /** Plain-language goal spoken to the patient and stored on the CarePlan. */
  patientGoal: string;
  medications: MedOrder[];
  followUpDays: number;
  referralRequired: boolean;
  urgent: boolean;
}

export interface SafetyFinding {
  severity: Severity;
  code: 'allergy-match' | 'duplicate-therapy' | 'interaction' | 'note';
  message: string;
  medication?: string;
}

export interface RiskFinding {
  severity: Severity;
  code: string;
  message: string;
}

export interface Citation {
  title: string;
  source: string;
  url?: string;
}

export interface ResearchFinding {
  topic: string;
  rationale: string;
  citations: Citation[];
  /** False when the deterministic fallback text was used. */
  grounded: boolean;
}

export type ReviewStance = 'agree' | 'concern' | 'suggest-edit';

export interface PanelReview {
  persona: string;
  specialty: string;
  stance: ReviewStance;
  rationale: string;
  suggestedEdit?: string;
  /** False when the deterministic fallback was used. */
  live: boolean;
}

export type PanelConsensus = 'approve-as-drafted' | 'approve-with-notes' | 'revise';

export interface PanelResult {
  reviews: PanelReview[];
  consensus: PanelConsensus;
}

export interface CoverageResult {
  planName?: string;
  covered: boolean | 'not-confirmed';
  copayUsd?: number;
  priorAuthRequired: boolean | 'unknown';
  notes: string[];
  /** True when this came from the deterministic mock rather than a live 271. */
  mock: boolean;
}

export interface RetrievalSnippet {
  text: string;
  source: string;
  score: number;
  mock: boolean;
}

/** Everything the post-call pipeline needs, captured during the call. */
export interface CallOutcome {
  callId: string;
  patientId: string;
  moduleId: string;
  answers: InstrumentAnswer[];
  riskAnswers: RiskAnswer[];
  concerns: Concern[];
  startedAt: string;
  endedAt: string;
}

/** The complete draft assembled by the post-call pipeline. */
export interface DraftPlan {
  callId: string;
  patientId: string;
  moduleId: string;
  score: ScoreResult;
  step: ProtocolStep;
  safety: SafetyFinding[];
  risks: RiskFinding[];
  research: ResearchFinding[];
  panel: PanelResult;
  coverage?: CoverageResult;
  patientRecap: string;
  /** Escalation was warranted: an urgent Task should exist. */
  escalated: boolean;
}
