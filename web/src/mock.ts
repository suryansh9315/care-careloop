/**
 * Local mock backend for visual development.
 *
 * The dashboard is gated behind a Medplum user login, so the authenticated
 * screens can only be seen with a real session. Running with VITE_MOCK=1 swaps
 * the Medplum client for this in-memory fixture set, so every screen can be
 * viewed and iterated on without credentials. It is dev-only and never bundled
 * into a normal build path — `medplum.ts` selects it purely on the env flag.
 */

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const H = 3600_000;
const D = 24 * H;

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LOINC = 'http://loinc.org';

function patient(id: string, given: string, family: string, birthDate: string, phone: string, updatedAgo = 2 * H): any {
  return {
    resourceType: 'Patient', id,
    name: [{ given: [given], family, text: `${given} ${family}` }],
    birthDate,
    telecom: [{ system: 'phone', value: phone }],
    meta: { lastUpdated: iso(updatedAgo) },
  };
}

function carePlan(id: string, subject: string, title: string, status: string, createdAgo: number, medIds: string[] = []): any {
  return {
    resourceType: 'CarePlan', id, status, intent: 'plan',
    subject: { reference: `Patient/${subject}` },
    title,
    description: 'Step up to medium-dose ICS-formoterol MART with a short oral corticosteroid course to regain control; review technique, adherence and triggers.',
    created: iso(createdAgo),
    note: [{ text: 'Patient goal: get through a normal day without reaching for the reliever.' }],
    activity: medIds.map((m) => ({ reference: { reference: `MedicationRequest/${m}` } })),
    meta: { lastUpdated: iso(createdAgo) },
  };
}

function comm(id: string, subject: string, category: string, text: string, sentAgo = H, topic?: string): any {
  return {
    resourceType: 'Communication', id, status: 'completed',
    subject: { reference: `Patient/${subject}` },
    category: [{ text: category }],
    ...(topic ? { topic: { text: topic } } : {}),
    sent: iso(sentAgo),
    payload: [{ contentString: text }],
  };
}

function scoreObs(id: string, subject: string, total: number, agoDays: number, band: string): any {
  return {
    resourceType: 'Observation', id, status: 'final',
    subject: { reference: `Patient/${subject}` },
    effectiveDateTime: iso(agoDays * D),
    code: { coding: [{ system: LOINC, code: '82673-3', display: 'ACT total score' }], text: 'ACT total score' },
    valueQuantity: { value: total, unit: '{score}' },
    interpretation: [{ text: band }],
  };
}

function itemObs(id: string, subject: string, code: string, value: number): any {
  return {
    resourceType: 'Observation', id, status: 'final',
    subject: { reference: `Patient/${subject}` },
    effectiveDateTime: iso(2 * H),
    code: { coding: [{ system: LOINC, code }] },
    valueInteger: value,
  };
}

function med(id: string, subject: string, display: string, code: string, sig: string): any {
  return {
    resourceType: 'MedicationRequest', id, status: 'draft', intent: 'proposal',
    subject: { reference: `Patient/${subject}` },
    medicationCodeableConcept: { coding: [{ system: RXNORM, code, display }], text: display },
    dosageInstruction: [{ text: sig }],
  };
}

// --- Maria: the fully-populated critical case ------------------------------
const M = 'p-maria';
const mariaMeds = [
  med('m1', M, 'Budesonide 160 mcg / formoterol 4.5 mcg inhaler', '745750', 'Inhale 2 puffs twice daily plus 1 as needed'),
  med('m2', M, 'Albuterol sulfate 90 mcg/actuation inhaler', '745679', 'Inhale 2 puffs every 4-6 hours as needed'),
  med('m3', M, 'Prednisone 20 mg oral tablet', '312615', 'Take 2 tablets once daily for 5 days'),
];

const PANEL_TEXT = [
  'Respiratory physician (Respiratory medicine) — concern\nThe step-up to medium-dose ICS-formoterol MART is appropriate, but propranolol (a non-selective beta blocker) may antagonise the bronchodilation of formoterol and reduce effectiveness.\nSuggested edit: Review whether propranolol can be replaced with a cardioselective agent.',
  'Clinical pharmacist (Pharmacy) — concern\nThe regimen overlaps an existing albuterol reliever; clarify whether it replaces or adds. Also flags the propranolol / formoterol interaction.\nSuggested edit: Confirm reliever intent and reconcile the beta-blocker.',
  'Medication safety reviewer (Medication safety) — concern\nOngoing propranolol with a beta-agonist controller in poorly controlled asthma is the main safety issue; oral steroid course is appropriate short term.\nSuggested edit: Escalate the beta-blocker interaction to the prescriber.',
].join('\n\n');

const resources: any[] = [
  { ...patient(M, 'Maria', 'Reyes', '1979-05-14', '+13215550111', 21 * H), gender: 'female', address: [{ city: 'Oakland', state: 'CA' }] },
  patient('p-saket', 'Saket', 'Toshniwal', '1994-07-14', '+13219399699', 1 * H),
  patient('p-eshan', 'Eshan', 'Toshniwal', '1990-01-01', '+16505129410', 3 * D),

  carePlan('cp-maria', M, 'Asthma plan — Very poorly controlled (ACT 10)', 'draft', 21 * H, ['m1', 'm2', 'm3']),
  carePlan('cp-maria-older', M, 'Asthma plan — Poorly controlled (ACT 13)', 'draft', 3 * D, ['m1']),
  carePlan('cp-saket', 'p-saket', 'Asthma plan — Poorly controlled (ACT 13)', 'draft', 1 * H, ['m1']),
  carePlan('cp-eshan', 'p-eshan', 'Asthma plan — Not well controlled (ACT 17)', 'draft', 2 * D, ['m1']),
  carePlan('cp-maria-prev', M, 'Asthma plan — Not well controlled (ACT 16)', 'active', 30 * D),

  ...mariaMeds,

  // Maria score trend (deteriorating) + latest items
  scoreObs('o1', M, 24, 90, 'Well controlled'),
  scoreObs('o2', M, 22, 60, 'Well controlled'),
  scoreObs('o3', M, 21, 40, 'Not well controlled'),
  scoreObs('o4', M, 19, 21, 'Not well controlled'),
  scoreObs('o5', M, 17, 7, 'Not well controlled'),
  scoreObs('o6', M, 10, 0, 'Very poorly controlled'),
  itemObs('i1', M, '82668-3', 4),
  itemObs('i2', M, '82669-1', 2),
  itemObs('i3', M, '82670-9', 1),
  itemObs('i4', M, '82671-7', 2),
  itemObs('i5', M, '82672-5', 1),

  // Eshan and Saket deliberately share a score, to exercise the collision case
  scoreObs('e1', 'p-eshan', 17, 0, 'Not well controlled'),
  scoreObs('s1', 'p-saket', 17, 0, 'Not well controlled'),

  // Maria review artifacts
  comm('c-safety', M, 'careloop-safety',
    '[critical] reliever-overuse: Reports 5+ reliever canisters in 12 months — associated with increased mortality and inadequate controller therapy.\n[warning] smoke-exposure: Ongoing smoke exposure reduces inhaled corticosteroid responsiveness.', 21 * H, 'Safety and risk findings'),
  comm('c-panel', M, 'careloop-panel', PANEL_TEXT, 21 * H, 'Expert panel — revise'),
  comm('c-research', M, 'careloop-research',
    'TOPIC: Evidence-based management of asthma with ACT 10 (very poorly controlled)\nMedium-dose ICS-formoterol MART with a short oral corticosteroid course aligns with GINA stepwise care; reliever overuse and adherence should be addressed.\nCitations: Global Initiative for Asthma; NHLBI; AAAAI', 21 * H, 'Evidence synthesis'),
  comm('c-coverage', M, 'careloop-coverage',
    'Plan: Gold Plan HMO\nCovered: true\nEstimated copay: $15\nPrior authorisation: true\nSOURCE: live 271 response.', 21 * H, 'Coverage and eligibility'),
  comm('c-recap', M, 'careloop-recap',
    'Thanks for the check-in, Maria. From what you shared, your asthma has been very poorly controlled lately and you are relying on your rescue inhaler quite a bit — your care team will look at the preventer side and follow up before your visit.', 21 * H, 'Patient recap'),
  comm('c-concern', M, 'careloop-concern', 'I keep waking up around four in the morning coughing and I am shattered at work.', 21 * H),
  comm('c-chart1', M, 'careloop-chart', 'ACT item 2 (shortness of breath) recorded: 2', 21 * H),
  comm('c-chart2', M, 'careloop-chart', 'ACT completed by phone check-in → 10 (Very poorly controlled)', 21 * H),
  comm('c-edu', M, 'careloop-education', 'Explained reliever vs controller inhaler and rinse-and-spit technique.', 21 * H),

  // Call log
  comm('call-1', M, 'careloop-call', 'Outbound check-in call completed', 21 * H),
  comm('call-2', 'p-saket', 'careloop-call', 'Outbound check-in call completed', 1 * H),
  comm('call-3', 'p-eshan', 'careloop-call', 'Outbound check-in call completed', 2 * D),
  comm('call-4', M, 'careloop-call', 'Outbound call no-answer', 3 * D),

  // Review task (urgent)
  {
    resourceType: 'Task', id: 't-maria', status: 'requested', intent: 'order', priority: 'urgent',
    description: 'Clinician review of drafted asthma plan',
    focus: { reference: 'CarePlan/cp-maria' },
  },
];

function matches(r: any, query: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (k === '_count' || k === '_sort') continue;
    if (k === 'status' && r.status !== v) return false;
    if ((k === 'subject' || k === 'patient') && r.subject?.reference !== v && r.beneficiary?.reference !== v) return false;
    if (k === 'category' && !r.category?.some((c: any) => c.text === v)) return false;
    if (k === 'focus' && r.focus?.reference !== v) return false;
    if (k === 'code' && !r.code?.coding?.some((c: any) => v.includes(c.code))) return false;
  }
  return true;
}

export const mockMedplum = {
  isAuthenticated: () => true,
  getProfile: () => ({ resourceType: 'Practitioner', name: [{ given: ['Ada'], family: 'Chen' }] }),
  getActiveLogin: () => ({ profile: { display: 'ada@careloop.demo' } }),
  async searchResources(type: string, query: Record<string, string> = {}) {
    const out = resources.filter((r) => r.resourceType === type && matches(r, query));
    const sort = query._sort;
    if (sort) {
      const desc = sort.startsWith('-');
      const field = sort.replace('-', '');
      const key = (r: any): string =>
        field === 'date' ? (r.effectiveDateTime ?? r.issued ?? '')
        : field === 'sent' ? (r.sent ?? '')
        : field === '_lastUpdated' ? (r.meta?.lastUpdated ?? r.created ?? '')
        : '';
      out.sort((a, b) => (desc ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b))));
    }
    return out;
  },
  async readResource(type: string, id: string) {
    return resources.find((r) => r.resourceType === type && r.id === id);
  },
  async updateResource(r: any) { return r; },
  async signOut() {},
  async startLogin() { return { code: 'mock' }; },
  async processCode() {},
  async post() { return {}; },
};
