import type { CarePlan, Patient } from '@medplum/fhirtypes';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Render tests for every screen.
 *
 * These exist because the dashboard is only reachable behind a Medplum user
 * login, so the authenticated pages were shipped without anyone — human or
 * otherwise — ever seeing them render. A crash in any of them unmounts the
 * tree and shows a blank white page, which during a demo is indistinguishable
 * from a dead server. Each page is mounted here against stubbed data so that
 * class of failure is caught before it reaches a screen.
 */

vi.mock('../medplum', () => ({
  medplum: {
    isAuthenticated: () => true,
    getProfile: () => ({ resourceType: 'Practitioner', name: [{ given: ['Ada'], family: 'Chen' }] }),
    getActiveLogin: () => ({ profile: { display: 'ada@clinic.example' } }),
    searchResources: vi.fn(async () => []),
    readResource: vi.fn(async () => undefined),
    updateResource: vi.fn(async (r: unknown) => r),
    signOut: vi.fn(async () => undefined),
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
  PROJECT_ID: 'test',
}));

vi.mock('../bridge', () => ({
  getHealth: vi.fn(async () => ({
    ok: true,
    activeCalls: 0,
    live: { medplum: true, twilio: true, deepgram: true, moss: true, stedi: true, llm: true },
  })),
  getModules: vi.fn(async () => [
    { id: 'asthma', display: 'Asthma', instrument: 'ACT', items: 5, riskQuestions: 5, bands: 4, medications: 8, icd10: 'J45.909' },
  ]),
  getCondition: vi.fn(async () => ({ id: 'asthma', display: 'Asthma' })),
  saveCondition: vi.fn(async () => ({ saved: 'asthma', modules: 2 })),
  reloadConditions: vi.fn(async () => ({ stored: 2, total: 2 })),
  createIntake: vi.fn(async () => ({ patientId: 'p1', conditionId: 'c1', moduleId: 'asthma' })),
  startCall: vi.fn(async () => ({ callId: 'call-1', callSid: 'CA1', mock: false })),
  approve: vi.fn(async () => ({ approved: true })),
}));

import { CallsPage } from './Calls';
import { DashboardPage } from './Dashboard';
import { IntakePage } from './Intake';
import { LivePage } from './Live';
import { PatientPage } from './Patient';
import { PatientsPage } from './Patients';
import { ReviewPage } from './Review';
import { TreatmentsPage } from './Treatments';
import { App } from '../App';

const patient: Patient = {
  resourceType: 'Patient',
  id: 'p1',
  name: [{ given: ['Hackathon'], family: 'Demo' }],
  birthDate: '1990-01-01',
  telecom: [{ system: 'phone', value: '+13215550123' }],
};

const plan: CarePlan = {
  resourceType: 'CarePlan',
  id: 'cp1',
  status: 'draft',
  intent: 'plan',
  subject: { reference: 'Patient/p1' },
  title: 'Asthma plan — Poorly controlled (ACT 13)',
  description: 'Step up to medium-dose ICS-formoterol MART.',
  created: new Date().toISOString(),
};

beforeEach(() => vi.clearAllMocks());

describe('every page renders', () => {
  it('Dashboard', async () => {
    render(
      <DashboardPage plans={[plan]} patients={[patient]} onOpenPlan={vi.fn()} onOpenPatient={vi.fn()} onNavigate={vi.fn()} />,
    );
    expect(await screen.findByText(/1 draft plan awaiting review/i)).toBeInTheDocument();
    expect(screen.getByText('Asthma plan — Poorly controlled (ACT 13)')).toBeInTheDocument();
  });

  it('Dashboard with no data shows guidance, not a blank card', async () => {
    render(<DashboardPage plans={[]} patients={[]} onOpenPlan={vi.fn()} onOpenPatient={vi.fn()} onNavigate={vi.fn()} />);
    expect(await screen.findByText(/queue is clear/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is waiting for review/i)).toBeInTheDocument();
  });

  it('Review with a selected plan shows the panels', async () => {
    render(<ReviewPage plans={[plan]} selected={plan} onSelect={vi.fn()} onChanged={vi.fn()} />);
    for (const panel of [
      'Asthma Control Test',
      'Drafted regimen',
      'Medication safety',
      'Clinician note',
      'Evidence',
      'Expert panel',
      'Approval',
    ]) {
      expect(
        await screen.findByRole('heading', { name: panel }),
        `panel "${panel}" is missing`,
      ).toBeInTheDocument();
    }
  });

  it('Review with nothing selected prompts a selection', async () => {
    render(<ReviewPage plans={[]} selected={undefined} onSelect={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText(/nothing waiting/i)).toBeInTheDocument();
  });

  it('Live', async () => {
    render(<LivePage patients={[patient]} patientId="p1" onSelect={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Live' })).toBeInTheDocument();
    expect(screen.getByText(/coded observations/i)).toBeInTheDocument();
  });

  it('Calls', async () => {
    render(<CallsPage onOpenPatient={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Calls' })).toBeInTheDocument();
  });

  it('Patients', async () => {
    render(<PatientsPage patients={[patient]} onOpenLive={vi.fn()} onOpenPatient={vi.fn()} />);
    expect(await screen.findByText('Hackathon Demo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /call/i })).toBeInTheDocument();
  });

  it('Patient hub', async () => {
    render(
      <PatientPage
        patientId="p1"
        patients={[patient]}
        onOpenPlan={vi.fn()}
        onOpenLive={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Hackathon Demo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Care plans' })).toBeInTheDocument();
  });

  it('Intake', async () => {
    render(<IntakePage onCallStarted={vi.fn()} />);
    expect(await screen.findByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/phone/i)).toBeInTheDocument();
  });

  it('Treatments', async () => {
    render(<TreatmentsPage />);
    expect(await screen.findByRole('heading', { name: 'Treatments' })).toBeInTheDocument();
  });

  it('App shell renders every nav destination', async () => {
    render(<App />);
    const nav = await screen.findByRole('navigation');
    for (const label of ['Dashboard', 'Live', 'Review queue', 'Calls', 'Patients', 'New intake', 'Treatments']) {
      expect(
        within(nav).getByRole('button', { name: new RegExp(`^${label}`, 'i') }),
        `nav item "${label}" is missing`,
      ).toBeInTheDocument();
    }
  });
});

describe('a patient with no phone cannot be dialled', () => {
  it('disables the call button', async () => {
    const noPhone: Patient = { ...patient, telecom: [] };
    render(<PatientsPage patients={[noPhone]} onOpenLive={vi.fn()} onOpenPatient={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /call/i })).toBeDisabled());
  });
});

/**
 * The screens are views of the same patient, so every one of them has to lead
 * somewhere. A queue you can look at but not act from is the difference
 * between a demo and a tool.
 */
describe('the screens are connected', () => {
  it('a queue row opens that plan', async () => {
    const onOpenPlan = vi.fn();
    render(
      <DashboardPage
        plans={[plan]} patients={[patient]}
        onOpenPlan={onOpenPlan} onOpenPatient={vi.fn()} onNavigate={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByText('Asthma plan — Poorly controlled (ACT 13)'));
    expect(onOpenPlan).toHaveBeenCalledWith(plan);
  });

  it('the stat header links into the review queue', async () => {
    const onNavigate = vi.fn();
    render(
      <DashboardPage
        plans={[plan]} patients={[patient]}
        onOpenPlan={vi.fn()} onOpenPatient={vi.fn()} onNavigate={onNavigate}
      />,
    );
    fireEvent.click((await screen.findAllByText(/view all/i))[0]!);
    expect(onNavigate).toHaveBeenCalledWith('review');
  });

  it('New intake is reachable from the dashboard header', async () => {
    const onNavigate = vi.fn();
    render(
      <DashboardPage
        plans={[]} patients={[]}
        onOpenPlan={vi.fn()} onOpenPatient={vi.fn()} onNavigate={onNavigate}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'New intake' }));
    expect(onNavigate).toHaveBeenCalledWith('intake');
  });

  it('a review plan links to that patient’s charting feed', async () => {
    const onOpenLive = vi.fn();
    render(
      <ReviewPage
        plans={[plan]} selected={plan}
        onSelect={vi.fn()} onChanged={vi.fn()} onOpenLive={onOpenLive}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /charting feed/i }));
    expect(onOpenLive).toHaveBeenCalledWith('p1');
  });

  it('a patient row opens that patient’s record hub', async () => {
    const onOpenPatient = vi.fn();
    render(
      <PatientsPage patients={[patient]} onOpenLive={vi.fn()} onOpenPatient={onOpenPatient} />,
    );
    fireEvent.click(await screen.findByText('Hackathon Demo'));
    expect(onOpenPatient).toHaveBeenCalledWith('p1');
  });

  it('picking a patient on Live selects them', async () => {
    const onSelect = vi.fn();
    render(<LivePage patients={[patient]} patientId="p1" onSelect={onSelect} />);
    fireEvent.click((await screen.findAllByText('Hackathon Demo'))[0]!);
    expect(onSelect).toHaveBeenCalledWith('p1');
  });

  it('dialling always asks first and never fires on a single click', async () => {
    const { startCall } = await import('../bridge');
    render(<PatientsPage patients={[patient]} onOpenLive={vi.fn()} onOpenPatient={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /call/i }));

    // The confirm dialog is shown; no call has been placed yet.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(startCall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /call now/i }));
    await waitFor(() => expect(startCall).toHaveBeenCalledWith('p1', undefined));
  });
});
