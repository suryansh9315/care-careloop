import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import Page from "./components/Page";
import DraftReview from "./pages/DraftReview";
import ReviewQueue from "./pages/ReviewQueue";

/**
 * Standalone harness — NOT the federation entrypoint.
 *
 * The host only ever imports `./manifest`. This exists so `vite preview` serves
 * something and the plugin can be developed without running care_fe. The host
 * supplies its own QueryClientProvider and i18n; here they have to be stood up
 * by hand, which is exactly why this file is not representative of how the
 * plugin actually runs.
 *
 * Drive it with query parameters:
 *   ?facility=<uuid>   the queue
 *   ?draft=<uuid>      one draft
 */
window.CARE_API_URL ??= "http://localhost:25768";

const params = new URLSearchParams(window.location.search);
const draftId = params.get("draft");
const facilityId = params.get("facility") ?? "";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Page>
        {draftId ? (
          <DraftReview draftId={draftId} />
        ) : (
          <ReviewQueue facilityId={facilityId} />
        )}
      </Page>
    </QueryClientProvider>
  </StrictMode>,
);
