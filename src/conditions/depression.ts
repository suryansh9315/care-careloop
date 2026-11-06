import { isAffirmative } from '../orchestration/numbers.js';
import type { InstrumentAnswer, MedOrder, RiskAnswer, RiskFinding, ScoreResult } from '../types.js';
import type { ConditionModule } from './types.js';

/** See the code note in `asthma.ts` — these RxNorm CUIs are seed values. */

const SERTRALINE_50: MedOrder = {
  display: 'Sertraline 50 mg oral tablet',
  rxnormCode: '312940',
  role: 'primary',
  sig: 'Take 1 tablet (50 mg) by mouth once daily in the morning',
  route: 'oral',
  frequency: 'daily',
  prn: false,
  durationDays: 30,
  quantity: 30,
  refills: 2,
  ingredients: ['sertraline'],
};

const SERTRALINE_25_START: MedOrder = {
  ...SERTRALINE_50,
  display: 'Sertraline 25 mg oral tablet',
  rxnormCode: '312938',
  sig: 'Take 1 tablet (25 mg) by mouth once daily for 7 days, then increase to 50 mg daily',
  quantity: 30,
};

function depressionRiskRules(answers: RiskAnswer[], score: ScoreResult): RiskFinding[] {
  const findings: RiskFinding[] = [];
  const get = (linkId: string) => answers.find((a) => a.linkId === linkId)?.value ?? '';
  const isYes = isAffirmative;

  if (isYes(get('risk-prior-attempt'))) {
    findings.push({
      severity: 'critical',
      code: 'prior-attempt',
      message: 'History of a prior suicide attempt — the strongest single predictor of future attempt. Requires clinician contact regardless of PHQ-9 band.',
    });
  }

  if (isYes(get('risk-support'))) {
    findings.push({
      severity: 'warning',
      code: 'low-support',
      message: 'Patient reports little or no day-to-day support, which reduces the safety of a purely remote plan.',
    });
  }

  if (isYes(get('risk-substance'))) {
    findings.push({
      severity: 'warning',
      code: 'substance-use',
      message: 'Increased alcohol or substance use reported alongside low mood — affects both risk and treatment response.',
    });
  }

  if (isYes(get('risk-prior-treatment'))) {
    findings.push({
      severity: 'info',
      code: 'prior-treatment',
      message: 'Patient has taken an antidepressant before; prior agent, dose, duration and response should be confirmed before selecting therapy.',
    });
  }

  if (score.crisisOverride) {
    findings.push({
      severity: 'critical',
      code: 'self-harm-item',
      message: 'PHQ-9 item 9 was answered above zero. Crisis pathway applies and overrides the score band.',
    });
  } else if (score.total >= 20) {
    findings.push({
      severity: 'warning',
      code: 'severe-score',
      message: `PHQ-9 total of ${score.total} is in the severe range.`,
    });
  }

  return findings;
}

export const depressionModule: ConditionModule = {
  id: 'depression',
  display: 'Major depressive disorder',
  icd10: 'F32.9',
  snomed: '370143000',

  instrument: {
    id: 'phq9',
    name: 'Patient Health Questionnaire-9 (PHQ-9)',
    loincPanelCode: '44249-1',
    loincTotalCode: '44261-6',
    minTotal: 0,
    maxTotal: 27,
    direction: 'higher-is-worse',
    items: [
      { linkId: 'phq9-1', loincCode: '44250-9', prompt: 'Over the last 2 weeks, how often have you had little interest or pleasure in doing things?', min: 0, max: 3, scaleHint: '0 means not at all, 1 several days, 2 more than half the days, 3 nearly every day' },
      { linkId: 'phq9-2', loincCode: '44255-8', prompt: 'Over the last 2 weeks, how often have you been feeling down, depressed, or hopeless?', min: 0, max: 3, scaleHint: '0 means not at all, 3 means nearly every day' },
      { linkId: 'phq9-3', loincCode: '44259-0', prompt: 'How often have you had trouble falling or staying asleep, or sleeping too much?', min: 0, max: 3, scaleHint: '0 means not at all, 3 means nearly every day' },
      { linkId: 'phq9-4', loincCode: '44254-1', prompt: 'How often have you been feeling tired or having little energy?', min: 0, max: 3, scaleHint: '0 means not at all, 3 means nearly every day' },
      { linkId: 'phq9-5', loincCode: '44251-7', prompt: 'How often have you had a poor appetite or been overeating?', min: 0, max: 3, scaleHint: '0 means not at all, 3 means nearly every day' },
      { linkId: 'phq9-6', loincCode: '44258-2', prompt: 'How often have you been feeling bad about yourself, or that you are a failure, or have let yourself or your family down?', min: 0, max: 3, scaleHint: '0 means not at all, 3 means nearly every day' },
      { linkId: 'phq9-7', loincCode: '44252-5', prompt: 'How often have you had trouble concentrating on things, such as reading or watching television?', min: 0, max: 3, scaleHint: '0 means not at all, 3 means nearly every day' },
      { linkId: 'phq9-8', loincCode: '44253-3', prompt: 'How often have you been moving or speaking so slowly that other people could have noticed, or been so restless that you have been moving around a lot more than usual?', min: 0, max: 3, scaleHint: '0 means not at all, 3 means nearly every day' },
      { linkId: 'phq9-9', loincCode: '44260-8', prompt: 'Over the last 2 weeks, how often have you had thoughts that you would be better off dead, or of hurting yourself in some way?', min: 0, max: 3, scaleHint: '0 means not at all, 3 means nearly every day' },
    ],
  },

  bands: [
    { id: 'minimal', label: 'Minimal', min: 0, max: 4 },
    { id: 'mild', label: 'Mild', min: 5, max: 9 },
    { id: 'moderate', label: 'Moderate', min: 10, max: 14 },
    { id: 'moderately-severe', label: 'Moderately severe', min: 15, max: 19 },
    { id: 'severe', label: 'Severe', min: 20, max: 27 },
  ],

  riskQuestions: [
    { linkId: 'risk-prior-attempt', prompt: 'Have you ever made an attempt to end your life?', expects: 'yes-no' },
    { linkId: 'risk-support', prompt: 'Is there someone in your day-to-day life you can talk to when things get hard?', expects: 'yes-no' },
    { linkId: 'risk-substance', prompt: 'Has your drinking or use of any other substance increased recently?', expects: 'yes-no' },
    { linkId: 'risk-prior-treatment', prompt: 'Have you taken medication for your mood before?', expects: 'yes-no' },
  ],

  // Item 9 above zero overrides the numeric band entirely.
  crisisOverride: (answers: InstrumentAnswer[]) =>
    (answers.find((a) => a.linkId === 'phq9-9')?.value ?? 0) > 0,
  crisisBandId: 'crisis',

  steps: {
    minimal: {
      id: 'minimal',
      summary: 'Minimal symptoms. No pharmacotherapy indicated. Reinforce sleep, activity and social contact; re-screen at the next routine contact.',
      patientGoal: 'Keep doing what is working, and know what to watch for if things change.',
      medications: [],
      followUpDays: 180,
      referralRequired: false,
      urgent: false,
    },
    mild: {
      id: 'mild',
      summary: 'Mild symptoms. First-line is structured self-help or behavioural activation rather than medication. Re-score in six weeks.',
      patientGoal: 'Rebuild a bit of routine and activity, and see whether that shifts things over six weeks.',
      medications: [],
      followUpDays: 42,
      referralRequired: false,
      urgent: false,
    },
    moderate: {
      id: 'moderate',
      summary: 'Moderate symptoms. Offer an SSRI and/or structured psychological therapy. Start sertraline at a low dose and titrate. Review in two weeks for early tolerability.',
      patientGoal: 'Start treatment and check in within two weeks on how you are tolerating it.',
      medications: [SERTRALINE_25_START],
      followUpDays: 14,
      referralRequired: false,
      urgent: false,
    },
    'moderately-severe': {
      id: 'moderately-severe',
      summary: 'Moderately severe symptoms. Combined SSRI and psychological therapy is preferred. Refer for therapy and review in two weeks.',
      patientGoal: 'Start medication, get you into talking therapy, and review closely over the next fortnight.',
      medications: [SERTRALINE_50],
      followUpDays: 14,
      referralRequired: true,
      urgent: false,
    },
    severe: {
      id: 'severe',
      summary: 'Severe symptoms. Combined pharmacotherapy and therapy with prompt clinician contact and mental-health referral. Review within one week.',
      patientGoal: 'Get you started on treatment and speaking to a clinician within the next few days.',
      medications: [SERTRALINE_50],
      followUpDays: 7,
      referralRequired: true,
      urgent: true,
    },
    crisis: {
      id: 'crisis',
      summary:
        'Self-harm item endorsed. Crisis pathway: same-day clinician contact and risk assessment before any medication decision is finalised. Protocol does not select an antidepressant in this state.',
      patientGoal: 'Get you speaking to someone today, and make sure you have crisis numbers to hand.',
      medications: [],
      followUpDays: 1,
      referralRequired: true,
      urgent: true,
    },
  },

  emergencyRules: [
    'If the patient says they are thinking about ending their life, have a plan, or are in immediate danger, stop the questionnaire immediately. Tell them you are glad they said it, that help is available right now, and that they should call or text 988 (the Suicide and Crisis Lifeline in the US) or 111 in the UK, or go to the nearest emergency department. Stay warm and unhurried, do not diagnose, and end the call only after giving those numbers.',
    'If item 9 is answered above zero at any point, complete the remaining questions gently if the patient is willing, then say clearly that a clinician will contact them today, and give the 988 number before the call ends.',
    'Never tell the patient a medication will be started. All treatment is a draft for a clinician to review.',
  ],

  riskRules: depressionRiskRules,

  experts: [
    {
      id: 'psychiatrist',
      name: 'Consultant psychiatrist',
      specialty: 'Psychiatry',
      safetyReviewer: false,
      systemPrompt:
        'You are a consultant psychiatrist reviewing an automatically drafted depression plan before a human clinician sees it. Judge whether the treatment intensity matches the PHQ-9 band, the crisis state, and the reported risk factors. Be concise and specific. Return JSON only.',
    },
    {
      id: 'pharmacist',
      name: 'Clinical pharmacist',
      specialty: 'Pharmacy',
      safetyReviewer: false,
      systemPrompt:
        'You are a clinical pharmacist reviewing a drafted antidepressant regimen. Check starting dose, titration, duration, interactions with the recorded current medications, and monitoring requirements. Return JSON only.',
    },
    {
      id: 'safety',
      name: 'Risk and safety reviewer',
      specialty: 'Clinical risk',
      safetyReviewer: true,
      systemPrompt:
        'You are a clinical risk reviewer for a mental-health service. Your only job is to flag anything unsafe: unaddressed suicidality, a plan that is too light for the risk profile, missing crisis instructions, or an interaction. Raise "concern" if there is any real safety issue. Return JSON only.',
    },
  ],

  moss: {
    indexName: 'careloop-depression-kb',
    corpus: [
      {
        id: 'depression-what-phq9-is',
        source: 'CareLoop clinic education — about the questionnaire',
        text: 'The PHQ-9 is a nine-question check on how your mood has been over the last two weeks. It is not a diagnosis on its own. It gives your clinician a number they can compare over time, so you can both see whether things are getting better, staying the same, or getting worse. Answering honestly, including on the hardest question, is what makes it useful.',
      },
      {
        id: 'depression-ssri-onset',
        source: 'CareLoop clinic education — how antidepressants work',
        text: 'Antidepressants do not work straight away. Most people notice sleep and appetite shifting first, often within one to two weeks, while mood usually takes four to six weeks to move. Side effects tend to be strongest in the first week or two and then settle. This is why clinicians start low, review early, and ask you not to stop suddenly on your own.',
      },
      {
        id: 'depression-ssri-side-effects',
        source: 'CareLoop clinic education — side effects',
        text: 'Common early side effects of an SSRI include nausea, headache, a jittery or restless feeling, and disturbed sleep. These usually ease within two weeks. Sexual side effects can persist and are worth raising rather than tolerating in silence. Contact the clinic promptly if you feel more agitated, more restless, or more distressed after starting, especially in the first two weeks.',
      },
      {
        id: 'depression-behavioural-activation',
        source: 'CareLoop clinic education — behavioural activation',
        text: 'Behavioural activation is the most reliable self-help approach for low mood. The idea is that waiting to feel motivated before doing things keeps you stuck, so you schedule small, specific, achievable activities regardless of motivation and let the mood follow. Start smaller than feels worthwhile: a ten-minute walk at a fixed time beats a plan you will not do.',
      },
      {
        id: 'depression-crisis-support',
        source: 'CareLoop clinic education — crisis support',
        text: 'If you are having thoughts of ending your life, help is available right now. In the US you can call or text 988 for the Suicide and Crisis Lifeline, any time. In the UK call 111 or the Samaritans on 116 123. If you are in immediate danger, go to your nearest emergency department or call emergency services. Telling one person is the step that matters most.',
      },
      {
        id: 'depression-sleep',
        source: 'CareLoop clinic education — sleep and mood',
        text: 'Sleep and mood pull each other in both directions. A consistent wake time matters more than a consistent bedtime, daylight in the first hour helps set the rhythm, and alcohol fragments sleep even when it makes falling asleep easier. If sleep is the dominant problem, say so, because it changes what your clinician is likely to offer.',
      },
      {
        id: 'depression-therapy-options',
        source: 'CareLoop clinic education — talking therapy',
        text: 'Talking therapy works about as well as medication for mild to moderate depression, and the combination works better than either alone for more severe symptoms. Cognitive behavioural therapy and interpersonal therapy have the strongest evidence. Waiting lists vary, so being referred early matters even if you are also starting medication.',
      },
    ],
  },

  researchTopicTemplate: ({ conditionDisplay, band, total }) =>
    `Evidence-based management of ${conditionDisplay} with a PHQ-9 total of ${total} (${band}). ` +
    'Address treatment intensity, SSRI initiation and monitoring, psychological therapy, and suicide risk mitigation.',
};
