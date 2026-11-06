import { lazy } from "react";

import Page from "./components/Page";

// Keep heavy imports out of this module — it loads on every care_fe page load,
// for every user, whether or not they ever open CareLoop.
const ReviewQueue = lazy(() => import("./pages/ReviewQueue"));
const DraftReview = lazy(() => import("./pages/DraftReview"));

/**
 * Structural mirrors of the host's prop types.
 *
 * Plugins are separate builds, so `care_fe` types cannot be imported across the
 * federation boundary. Only the fields actually used are declared. Verified
 * against `care_fe/src/pluginTypes.ts` at revision 6e21fe29 — where, notably,
 * `AppShellOverlay` does NOT exist, so there is no global call banner.
 */
interface NavigationLink {
  url: string;
  name: string;
  icon?: React.ReactNode;
  children?: NavigationLink[];
}

interface Manifest {
  plugin: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes: Record<string, (...args: any) => React.ReactNode>;
  extends: string[];
  components: {
    PatientHomeActions: React.LazyExoticComponent<
      React.FC<{
        patient: { id: string };
        facilityId?: string;
        className?: string;
      }>
    >;
  };
  navItems?: NavigationLink[];
  userNavItems?: NavigationLink[];
  adminNavItems?: NavigationLink[];
}

/**
 * The queue is facility-scoped: the API requires an explicit `?facility=` so a
 * reviewer is always looking at one facility's queue on purpose. The route
 * reads it from the URL rather than guessing a default.
 */
function facilityFromLocation(): string {
  return new URLSearchParams(window.location.search).get("facility") ?? "";
}

const manifest: Manifest = {
  plugin: "care_careloop_fe",
  routes: {
    "/careloop": () => (
      <Page>
        <ReviewQueue facilityId={facilityFromLocation()} />
      </Page>
    ),
    "/facility/:facilityId/careloop": ({
      facilityId,
    }: {
      facilityId: string;
    }) => (
      <Page>
        <ReviewQueue facilityId={facilityId} />
      </Page>
    ),
    "/careloop/draft/:draftId": ({ draftId }: { draftId: string }) => (
      <Page>
        <DraftReview draftId={draftId} />
      </Page>
    ),
  },
  extends: [],
  components: {
    PatientHomeActions: lazy(() => import("./components/PatientHomeActions")),
  },
  navItems: [{ url: "/careloop", name: "CareLoop" }],
  userNavItems: [],
  adminNavItems: [],
};

export default manifest;
