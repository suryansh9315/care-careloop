import { isAffirmative, parseCount } from '../orchestration/numbers.js';
import type { InstrumentAnswer, ProtocolStep, RiskAnswer, RiskFinding, ScoreResult } from '../types.js';
import type { ConditionModule } from './types.js';

/**
 * NOTE ON CODES: the RxNorm CUIs below are seed values for a demonstration
 * formulary. They are re-validated at write time through Medplum's terminology
 * service (`validateMedicationCode`) and must be reviewed against a real
 * formulary before any production use.
 */

const MART_LOW: ProtocolStep['medications'][number] = {
  display: 'Budesonide 80 mcg / formoterol 4.5 mcg inhaler',
  rxnormCode: '745752',
  role: 'controller',
  sig: 'Inhale 2 puffs twice daily, plus 1 puff as needed for symptoms (max 12 puffs/day)',
  route: 'inhalation',
  frequency: 'BID + PRN',
  prn: false,
  durationDays: 90,
  quantity: 1,
  refills: 2,
  ingredients: ['budesonide', 'formoterol'],
};

const MART_MEDIUM: ProtocolStep['medications'][number] = {
  ...MART_LOW,
  display: 'Budesonide 160 mcg / formoterol 4.5 mcg inhaler',
  rxnormCode: '745750',
  sig: 'Inhale 2 puffs twice daily, plus 1 puff as needed for symptoms (max 12 puffs/day)',
};

const RELIEVER: ProtocolStep['medications'][number] = {
  display: 'Albuterol sulfate 90 mcg/actuation inhaler',
  rxnormCode: '745679',
  role: 'reliever',
  sig: 'Inhale 2 puffs every 4-6 hours as needed for shortness of breath or wheeze',
  route: 'inhalation',
  frequency: 'Q4-6H',
  prn: true,
  durationDays: 90,
  quantity: 1,
  refills: 2,
  ingredients: ['albuterol'],
};

const ORAL_STEROID: ProtocolStep['medications'][number] = {
  display: 'Prednisone 20 mg oral tablet',
  rxnormCode: '312615',
  role: 'adjunct',
  sig: 'Take 2 tablets (40 mg) by mouth once daily for 5 days',
  route: 'oral',
  frequency: 'daily',
  prn: false,
  durationDays: 5,
  quantity: 10,
  refills: 0,
  ingredients: ['prednisone'],
};

function asthmaRiskRules(answers: RiskAnswer[], score: ScoreResult): RiskFinding[] {
  const findings: RiskFinding[] = [];
  const get = (linkId: string) => answers.find((a) => a.linkId === linkId)?.value ?? '';
  const isYes = isAffirmative;

  // Answers arrive as speech, so "twice" and "about four" have to count.
  const exacerbationCount = parseCount(get('risk-exacerbations')) ?? 0;
  if (exacerbationCount >= 2) {
    findings.push({
      severity: 'critical',
      code: 'frequent-exacerbations',
      message: `Patient reports ${exacerbationCount} exacerbations requiring oral steroids in the past year — a strong predictor of future severe exacerbation.`,
    });
  } else if (exacerbationCount === 1) {
    findings.push({
      severity: 'warning',
      code: 'recent-exacerbation',
      message: 'One steroid-requiring exacerbation in the past year.',
    });
  }

  const canisters = parseCount(get('risk-reliever-canisters')) ?? 0;
  if (canisters >= 3) {
    findings.push({
      severity: 'critical',
      code: 'reliever-overuse',
      message: `Reports ${canisters} reliever canisters in 12 months. Three or more is associated with increased mortality risk and indicates inadequate controller therapy.`,
    });
  }

  if (isYes(get('risk-hospitalisation'))) {
    findings.push({
      severity: 'critical',
      code: 'prior-hospitalisation',
      message: 'Prior asthma hospitalisation or ICU admission — highest-risk phenotype.',
    });
  }

  if (isYes(get('risk-adherence-gap'))) {
    findings.push({
      severity: 'warning',
      code: 'adherence-gap',
      message: 'Patient reports missing controller doses. Adherence and inhaler technique should be addressed before stepping up therapy.',
    });
  }

  if (isYes(get('risk-smoke-exposure'))) {
    findings.push({
      severity: 'warning',
      code: 'smoke-exposure',
      message: 'Ongoing tobacco or smoke exposure reduces inhaled corticosteroid responsiveness.',
    });
  }

  if (score.total <= 15) {
    findings.push({
      severity: 'warning',
      code: 'uncontrolled-score',
      message: `ACT total of ${score.total} indicates poorly controlled asthma independent of the risk answers.`,
    });
  }

  return findings;
}

export const asthmaModule: ConditionModule = {
  id: 'asthma',
  display: 'Asthma',
  icd10: 'J45.909',
  snomed: '195967001',

  instrument: {
    id: 'act',
    name: 'Asthma Control Test (ACT)',
    loincPanelCode: '82674-1',
    loincTotalCode: '82673-3',
    minTotal: 5,
    maxTotal: 25,
    direction: 'higher-is-better',
    items: [
      {
        linkId: 'act-1',
        loincCode: '82668-3',
        prompt:
          'In the past 4 weeks, how much of the time did your asthma keep you from getting as much done at work, school or at home?',
        min: 1,
        max: 5,
        scaleHint:
          '1 = all of the time, 2 = most of the time, 3 = some of the time, 4 = a little of the time, 5 = none of the time',
      },
      {
        linkId: 'act-2',
        loincCode: '82669-1',
        prompt: 'During the past 4 weeks, how often have you had shortness of breath?',
        min: 1,
        max: 5,
        scaleHint:
          '1 = more than once a day, 2 = once a day, 3 = three to six times a week, 4 = once or twice a week, 5 = not at all',
      },
      {
        linkId: 'act-3',
        loincCode: '82670-9',
        prompt:
          'During the past 4 weeks, how often did your asthma symptoms wake you up at night or earlier than usual in the morning?',
        min: 1,
        max: 5,
        scaleHint:
          '1 = four or more nights a week, 2 = two or three nights a week, 3 = once a week, 4 = once or twice in the four weeks, 5 = not at all',
      },
      {
        linkId: 'act-4',
        loincCode: '82671-7',
        prompt:
          'During the past 4 weeks, how often have you used your rescue inhaler or nebulizer medication?',
        min: 1,
        max: 5,
        scaleHint:
          '1 = three or more times per day, 2 = one or two times per day, 3 = two or three times per week, 4 = once a week or less, 5 = not at all',
      },
      {
        linkId: 'act-5',
        loincCode: '82672-5',
        prompt: 'How would you rate your asthma control during the past 4 weeks?',
        min: 1,
        max: 5,
        scaleHint:
          '1 = not controlled at all, 2 = poorly controlled, 3 = somewhat controlled, 4 = well controlled, 5 = completely controlled',
      },
    ],
  },

  bands: [
    { id: 'very-poor', label: 'Very poorly controlled', min: 5, max: 10 },
    { id: 'poor', label: 'Poorly controlled', min: 11, max: 15 },
    { id: 'partial', label: 'Not well controlled', min: 16, max: 19 },
    { id: 'controlled', label: 'Well controlled', min: 20, max: 25 },
  ],

  riskQuestions: [
    {
      linkId: 'risk-exacerbations',
      prompt:
        'In the last twelve months, how many times have you needed a course of steroid tablets for your asthma?',
      expects: 'count',
    },
    {
      linkId: 'risk-reliever-canisters',
      prompt: 'Roughly how many rescue inhaler canisters have you gone through in the last year?',
      expects: 'count',
    },
    {
      linkId: 'risk-hospitalisation',
      prompt: 'Have you ever been admitted to hospital or intensive care because of your asthma?',
      expects: 'yes-no',
    },
    // Adherence-gap and smoke-exposure questions were cut to keep the call
    // short: three critical-severity predictors are worth the phone time, the
    // two warning-level ones were not. Their riskRules remain and simply never
    // fire without an answer.
  ],

  steps: {
    controlled: {
      id: 'controlled',
      summary:
        'Well controlled on current therapy. Continue as-needed ICS-formoterol reliever therapy; reinforce technique and adherence; no step-up indicated.',
      patientGoal: 'Keep your asthma as settled as it is now, and keep your reliever use low.',
      medications: [MART_LOW],
      followUpDays: 180,
      referralRequired: false,
      urgent: false,
    },
    partial: {
      id: 'partial',
      summary:
        'Not well controlled. Step up to low-dose ICS-formoterol maintenance-and-reliever therapy (MART) after confirming inhaler technique and adherence.',
      patientGoal: 'Get to the point where asthma is not waking you at night or limiting your day.',
      medications: [MART_LOW, RELIEVER],
      followUpDays: 42,
      referralRequired: false,
      urgent: false,
    },
    poor: {
      id: 'poor',
      summary:
        'Poorly controlled. Step up to medium-dose ICS-formoterol MART with a short oral corticosteroid course to regain control, review technique, adherence and trigger exposure, and arrange earlier clinical review.',
      patientGoal: 'Bring symptoms down so you can sleep through the night and get through a normal day.',
      // A short steroid course here rather than only at the worst band: an ACT
      // in the 11-15 range usually reflects active inflammation that a
      // controller step-up alone takes weeks to settle.
      medications: [MART_MEDIUM, RELIEVER, ORAL_STEROID],
      followUpDays: 21,
      referralRequired: false,
      urgent: false,
    },
    'very-poor': {
      id: 'very-poor',
      summary:
        'Very poorly controlled. Medium-dose ICS-formoterol MART plus a short oral corticosteroid course, urgent clinician contact, and respiratory specialist referral.',
      patientGoal:
        'Get your breathing stable quickly and have a clinician review you within the next few days.',
      medications: [MART_MEDIUM, RELIEVER, ORAL_STEROID],
      followUpDays: 7,
      referralRequired: true,
      urgent: true,
    },
  },

  emergencyRules: [
    'Red flags of a severe attack happening NOW: can only speak a few words at a time, breathless at rest, reliever not helping or needed every 1-2 hours, chest pain with breathlessness, blue lips or fingertips, drowsiness or confusion. If you hear any of these, stop the questionnaire and say ONCE: "This sounds like it could be an emergency. Please hang up, use your reliever, and call 911 right now." Then end the call — do not continue the questions.',
  ],

  riskRules: asthmaRiskRules,

  experts: [
    {
      id: 'respiratory',
      name: 'Respiratory physician',
      specialty: 'Respiratory medicine',
      safetyReviewer: false,
      systemPrompt:
        'You are a consultant respiratory physician reviewing an automatically drafted asthma plan before a human clinician sees it. Judge whether the step-up choice matches the ACT band and reported risk factors under current GINA-style stepwise care. Be concise and specific. Return JSON only.',
    },
    {
      id: 'pharmacist',
      name: 'Clinical pharmacist',
      specialty: 'Pharmacy',
      safetyReviewer: false,
      systemPrompt:
        'You are a clinical pharmacist reviewing a drafted asthma regimen. Check dose, device, duplicate therapy, PRN limits, quantity and refills for internal consistency and practicality. Return JSON only.',
    },
    {
      id: 'safety',
      name: 'Medication safety reviewer',
      specialty: 'Medication safety',
      safetyReviewer: true,
      systemPrompt:
        'You are a medication safety reviewer. Your only job is to flag anything that could harm this patient: allergy conflicts, contraindications, overlapping beta-agonists, oral steroid risk, or an under-treated high-risk phenotype. Raise "concern" if there is any real safety issue. Return JSON only.',
    },
  ],

  moss: {
    indexName: 'careloop-asthma-kb',
    corpus: [
      {
        id: 'asthma-inhaler-technique',
        source: 'CareLoop clinic education — inhaler technique',
        text: 'For a metered-dose inhaler: shake it, breathe all the way out away from the inhaler, seal your lips around the mouthpiece, start a slow steady breath in and press the canister once as you begin breathing in, keep breathing in slowly, then hold your breath for about ten seconds. Wait about thirty seconds between puffs. A spacer makes this much easier and gets more medicine into the lungs. Rinse your mouth and spit after using a steroid inhaler.',
      },
      {
        id: 'asthma-controller-vs-reliever',
        source: 'CareLoop clinic education — controller versus reliever',
        text: 'A controller (preventer) inhaler contains an inhaled steroid and is taken every day even when you feel well. It reduces the underlying inflammation over weeks. A reliever inhaler opens the airways within minutes but does nothing to the inflammation. Needing your reliever more than twice a week is a sign the controller is not doing enough. Some modern plans combine both in one inhaler, taken daily and also as needed.',
      },
      {
        id: 'asthma-warning-signs',
        source: 'CareLoop clinic education — warning signs',
        text: 'Warning signs that asthma is getting worse include waking at night with cough or wheeze, needing the reliever more often than usual, being unable to keep up with your usual activity, and a reliever that helps for less time than it used to. Signs that need emergency help right away are being too breathless to speak a full sentence, lips or fingertips turning blue, and a reliever that is not working at all.',
      },
      {
        id: 'asthma-action-plan',
        source: 'CareLoop clinic education — action plan',
        text: 'A written asthma action plan has three zones. Green means you are well: keep taking your controller. Yellow means symptoms are increasing: follow the step-up instructions your clinician gave you and contact the clinic. Red means severe symptoms: use your reliever and get emergency help. Keeping the plan somewhere visible makes it far more likely to be used.',
      },
      {
        id: 'asthma-triggers',
        source: 'CareLoop clinic education — triggers',
        text: 'Common asthma triggers include house dust mite, pollen, pet dander, mould, cold air, exercise, respiratory infections, tobacco smoke, vaping, strong fragrances and air pollution. Identifying your own pattern matters more than avoiding everything. Exercise-induced symptoms are usually a sign that the controller needs review rather than a reason to stop exercising.',
      },
      {
        id: 'asthma-steroid-safety',
        source: 'CareLoop clinic education — inhaled steroid safety',
        text: 'Inhaled steroid doses used for asthma are very small compared with steroid tablets. The common side effects are a hoarse voice and oral thrush, and both are largely prevented by rinsing and spitting after each dose and by using a spacer. Stopping the controller because you feel well is the most common reason asthma control is lost.',
      },
      {
        id: 'asthma-adherence',
        source: 'CareLoop clinic education — adherence',
        text: 'Most people miss controller doses sometimes. Linking the inhaler to something you already do every day, such as brushing your teeth, keeping it visible, and using a reminder are the approaches that work best. Tell your clinician honestly how often you miss doses, because increasing the dose of a medicine that is not being taken does not help.',
      },
    ],
  },

  researchTopicTemplate: ({ conditionDisplay, band, total, triggers }) =>
    `Evidence-based management of ${conditionDisplay} with an ACT total of ${total} (${band})` +
    (triggers.length ? `, with reported triggers: ${triggers.join(', ')}` : '') +
    '. Address step-up choice, inhaler technique and adherence, and exacerbation risk reduction.',
};

/** Exposed for testing. */
export const asthmaCrisisOverride = (_answers: InstrumentAnswer[]): boolean => false;
