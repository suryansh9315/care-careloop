import './test-offline.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CarePlan, MedicationRequest, Task } from '@medplum/fhirtypes';
import { clearMockStore, createResource, searchResources } from '../integrations/medplum.js';
import { approvePlan, unapprovePlan } from './plan.js';

/**
 * Approval activates real medication orders, so both directions of the
 * transition have to be exact: what approval turns on, withdrawal turns back
 * off, and neither one erases the history of the other.
 */

async function seedApprovedCandidate(): Promise<{ planId: string; medId: string; taskId: string }> {
  const med = await createResource<MedicationRequest>({
    resourceType: 'MedicationRequest',
    status: 'draft',
    intent: 'proposal',
    subject: { reference: 'Patient/p1' },
    medicationCodeableConcept: { text: 'Budesonide/formoterol' },
  });
  const plan = await createResource<CarePlan>({
    resourceType: 'CarePlan',
    status: 'draft',
    intent: 'plan',
    subject: { reference: 'Patient/p1' },
    title: 'Asthma plan',
    activity: [{ reference: { reference: `MedicationRequest/${med.id}` } }],
  });
  const task = await createResource<Task>({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    focus: { reference: `CarePlan/${plan.id}` },
  });
  return { planId: plan.id!, medId: med.id!, taskId: task.id! };
}

const read = async <T>(type: string, id: string): Promise<T> =>
  (await searchResources(type as never, { _id: id }))[0] as T;

beforeEach(() => clearMockStore());

describe('approvePlan', () => {
  it('activates the plan, its orders and completes the review task', async () => {
    const { planId, medId, taskId } = await seedApprovedCandidate();

    const result = await approvePlan({ carePlanId: planId, hasCriticalFlag: false, acknowledgedCriticalFlags: false });

    expect(result.approved).toBe(true);
    expect((await read<CarePlan>('CarePlan', planId)).status).toBe('active');
    const med = await read<MedicationRequest>('MedicationRequest', medId);
    expect(med.status).toBe('active');
    expect(med.intent).toBe('order');
    expect((await read<Task>('Task', taskId)).status).toBe('completed');
  });

  it('refuses to approve over an unacknowledged critical flag', async () => {
    const { planId } = await seedApprovedCandidate();
    const result = await approvePlan({ carePlanId: planId, hasCriticalFlag: true, acknowledgedCriticalFlags: false });
    expect(result.approved).toBe(false);
    expect((await read<CarePlan>('CarePlan', planId)).status).toBe('draft');
  });
});

describe('unapprovePlan', () => {
  it('returns the plan and its orders to draft and reopens the review task', async () => {
    const { planId, medId, taskId } = await seedApprovedCandidate();
    await approvePlan({ carePlanId: planId, hasCriticalFlag: false, acknowledgedCriticalFlags: false });

    const result = await unapprovePlan({ carePlanId: planId, reason: 'wrong patient' });

    expect(result.reverted).toBe(true);
    const plan = await read<CarePlan>('CarePlan', planId);
    expect(plan.status).toBe('draft');
    const med = await read<MedicationRequest>('MedicationRequest', medId);
    expect(med.status).toBe('draft');
    expect(med.intent).toBe('proposal');
    expect((await read<Task>('Task', taskId)).status).toBe('requested');
  });

  it('keeps the approval in the record rather than erasing it', async () => {
    const { planId } = await seedApprovedCandidate();
    await approvePlan({ carePlanId: planId, hasCriticalFlag: false, acknowledgedCriticalFlags: false });
    await unapprovePlan({ carePlanId: planId, reason: 'wrong patient' });

    const notes = (await read<CarePlan>('CarePlan', planId)).note?.map((n) => n.text ?? '') ?? [];
    expect(notes.some((t) => /^Approved at /.test(t))).toBe(true);
    expect(notes.some((t) => /Approval withdrawn at .*wrong patient/.test(t))).toBe(true);
  });

  it('will not revert a plan that was never approved', async () => {
    const { planId } = await seedApprovedCandidate();
    const result = await unapprovePlan({ carePlanId: planId });
    expect(result.reverted).toBe(false);
    expect(result.reason).toMatch(/draft/);
  });
});
