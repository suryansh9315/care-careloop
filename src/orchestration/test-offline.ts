/**
 * Import FIRST in any test that touches an integration.
 *
 * Tests run with the developer's real `.env`, so `createResource` and friends
 * write to the production FHIR server unless the global offline switch is
 * thrown. That is not hypothetical: the CarePlan approval tests left four draft
 * plans pointing at `Patient/p1`, which then sat in the clinician's review
 * queue as rows with no patient name.
 *
 * This lives beside the tests rather than in `vitest.config.ts` because the
 * dashboard package resolves that config too, and a root-relative `setupFiles`
 * entry cannot be loaded from there.
 */
import { goOffline } from '../config/env.js';

goOffline();

export {};
