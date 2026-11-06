import { describe, expect, it } from 'vitest';
import { asthmaModule } from '../conditions/asthma.js';
import type { PanelReview } from '../types.js';
import { aggregateConsensus } from './panel.js';

const review = (persona: string, stance: PanelReview['stance'], live = true): PanelReview => ({
  persona,
  specialty: 'test',
  stance,
  rationale: 'because',
  live,
});

const SAFETY = 'Medication safety reviewer';
const RESPIRATORY = 'Respiratory physician';
const PHARMACIST = 'Clinical pharmacist';

describe('aggregateConsensus', () => {
  it('returns approve-as-drafted when every live reviewer agrees', () => {
    const consensus = aggregateConsensus(
      [review(RESPIRATORY, 'agree'), review(PHARMACIST, 'agree'), review(SAFETY, 'agree')],
      asthmaModule,
    );
    expect(consensus).toBe('approve-as-drafted');
  });

  it('returns revise when the safety reviewer raises a concern', () => {
    const consensus = aggregateConsensus(
      [review(RESPIRATORY, 'agree'), review(PHARMACIST, 'agree'), review(SAFETY, 'concern')],
      asthmaModule,
    );
    expect(consensus).toBe('revise');
  });

  it('lets a safety concern outrank unanimous agreement elsewhere', () => {
    const consensus = aggregateConsensus(
      [review(RESPIRATORY, 'agree'), review(SAFETY, 'concern')],
      asthmaModule,
    );
    expect(consensus).toBe('revise');
  });

  it('returns approve-with-notes for a non-safety concern', () => {
    const consensus = aggregateConsensus(
      [review(RESPIRATORY, 'concern'), review(PHARMACIST, 'agree'), review(SAFETY, 'agree')],
      asthmaModule,
    );
    expect(consensus).toBe('approve-with-notes');
  });

  it('does not treat a fallback "agree" as real agreement', () => {
    const consensus = aggregateConsensus(
      [review(RESPIRATORY, 'agree', false), review(SAFETY, 'agree', false)],
      asthmaModule,
    );
    expect(consensus).toBe('approve-with-notes');
  });

  it('ignores a concern from a reviewer that did not actually run', () => {
    const consensus = aggregateConsensus(
      [review(RESPIRATORY, 'agree'), review(SAFETY, 'concern', false)],
      asthmaModule,
    );
    expect(consensus).not.toBe('revise');
  });
});
