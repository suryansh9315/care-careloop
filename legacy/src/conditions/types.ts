import type {
  InstrumentAnswer,
  ProtocolStep,
  RiskAnswer,
  RiskFinding,
  ScoreResult,
} from '../types.js';

export interface InstrumentItem {
  linkId: string;
  /** LOINC code for the individual item. */
  loincCode: string;
  /** The question Maya asks, verbatim. */
  prompt: string;
  /** Inclusive answer range. */
  min: number;
  max: number;
  /** Spoken description of what each end of the scale means. */
  scaleHint: string;
}

export interface RiskQuestion {
  linkId: string;
  prompt: string;
  /** Free text is allowed; these are hints for the agent, not validation. */
  expects: 'yes-no' | 'count' | 'text';
}

export interface Instrument {
  id: string;
  name: string;
  /** LOINC code for the panel/total-score Observation. */
  loincPanelCode: string;
  loincTotalCode: string;
  items: InstrumentItem[];
  minTotal: number;
  maxTotal: number;
  /** Higher total means better control (ACT) or worse severity (PHQ-9). */
  direction: 'higher-is-better' | 'higher-is-worse';
}

export interface ScoreBand {
  id: string;
  label: string;
  /** Inclusive. */
  min: number;
  max: number;
}

export interface ExpertPersona {
  id: string;
  name: string;
  specialty: string;
  /** Marks the reviewer whose `concern` forces a `revise` consensus. */
  safetyReviewer: boolean;
  systemPrompt: string;
}

export interface MossCorpusEntry {
  id: string;
  text: string;
  source: string;
}

export interface ConditionModule {
  id: string;
  display: string;
  icd10: string;
  snomed: string;
  instrument: Instrument;
  bands: ScoreBand[];
  riskQuestions: RiskQuestion[];
  /** Deterministic protocol step for a band id. */
  steps: Record<string, ProtocolStep>;
  /**
   * Rules that take precedence over the normal flow, spoken verbatim by the
   * agent. Emergency handling is never delegated to the language model.
   */
  emergencyRules: string[];
  /** Optional crisis override applied before banding (e.g. PHQ-9 item 9). */
  crisisOverride?: (answers: InstrumentAnswer[]) => boolean;
  /** Band chosen when the crisis override fires. */
  crisisBandId?: string;
  riskRules: (answers: RiskAnswer[], score: ScoreResult) => RiskFinding[];
  experts: ExpertPersona[];
  moss: {
    indexName: string;
    corpus: MossCorpusEntry[];
  };
  /** Template used to build the phenotype research topic. */
  researchTopicTemplate: (input: {
    conditionDisplay: string;
    band: string;
    total: number;
    triggers: string[];
  }) => string;
}
