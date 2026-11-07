import type {
  ApprovalResult,
  CareloopConfig,
  DraftDetail,
  DraftListItem,
  DraftStatus,
  MedicationProposal,
  Paginated,
  StartCallResult,
  ValueSetConcept,
} from "@/types";

const STAFF_TOKEN_KEY = "care_access_token";
const PATIENT_TOKEN_KEY = "care_patient_token";
const BASE_PATH = "/api/care_careloop";

/** The patient portal authenticates with an OTP token instead of a staff one. */
function getPatientToken(): string | null {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PATIENT_TOKEN_KEY) || "null",
    );
    return stored?.token ?? null;
  } catch {
    return null;
  }
}

export function isPatientSession() {
  return !localStorage.getItem(STAFF_TOKEN_KEY) && !!getPatientToken();
}

function getAuthToken() {
  return localStorage.getItem(STAFF_TOKEN_KEY) ?? getPatientToken();
}

/** OTP callers get a separate, phone-number-scoped set of routes. */
function scope() {
  return isPatientSession() ? "/otp" : "";
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, data: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

function readErrorMessage(status: number, data: unknown) {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const detail = record.detail ?? record.non_field_errors;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && typeof detail[0] === "string") return detail[0];
  }
  return `Request failed with status ${status}`;
}

export async function request<T>(
  endpoint: string,
  method: Method = "GET",
  body?: unknown,
  queryParams?: Record<string, string | number | boolean | undefined | null>,
): Promise<T> {
  let url = `${window.CARE_API_URL}${BASE_PATH}${endpoint}`;

  if (queryParams) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null && value !== "") {
        search.append(key, String(value));
      }
    }
    const qs = search.toString();
    if (qs) url += `?${qs}`;
  }

  const token = getAuthToken();

  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Parse text-then-JSON so empty 204 bodies don't throw.
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data,
      readErrorMessage(response.status, data),
    );
  }

  return data as T;
}

/**
 * Calls CARE core rather than this plugin. Used for the medication ValueSet
 * search, so the clinician binds a real SNOMED product from CARE's own
 * terminology rather than anything this plugin invented (constraint C2).
 */
async function coreRequest<T>(
  endpoint: string,
  method: Method = "GET",
  body?: unknown,
): Promise<T> {
  const token = getAuthToken();
  const response = await fetch(`${window.CARE_API_URL}/api/v1${endpoint}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data,
      readErrorMessage(response.status, data),
    );
  }
  return data as T;
}

export const API = {
  config: () => request<CareloopConfig>(`${scope()}/config/`),

  drafts: {
    /** The queue. A facility is required: a reviewer looks at one on purpose. */
    list: (facility: string, status?: DraftStatus) =>
      request<Paginated<DraftListItem>>(`/drafts/`, "GET", undefined, {
        facility,
        status,
      }),

    get: (id: string) => request<DraftDetail>(`/drafts/${id}/`),

    acknowledgeCritical: (id: string) =>
      request<DraftDetail>(`/drafts/${id}/acknowledge_critical/`, "POST", {}),

    updateProposal: (
      id: string,
      proposalId: string,
      body: {
        accepted?: boolean;
        snomed_code?: string;
        snomed_display?: string;
      },
    ) =>
      request<MedicationProposal>(
        `/drafts/${id}/proposals/${proposalId}/`,
        "PATCH",
        body,
      ),

    approve: (id: string, acknowledgeCritical = false) =>
      request<DraftDetail & { written: ApprovalResult }>(
        `/drafts/${id}/approve/`,
        "POST",
        { acknowledge_critical: acknowledgeCritical },
      ),

    reject: (id: string, reason: string) =>
      request<DraftDetail>(`/drafts/${id}/reject/`, "POST", { reason }),
  },

  /**
   * Start a check-in call for one patient, now. Mirrors the previous
   * implementation's trigger rather than a scheduled campaign: a clinician
   * decides who gets called.
   *
   * The destination number is NOT sent — the backend reads it from the
   * patient's record, so this endpoint cannot be used to dial an arbitrary
   * number.
   */
  startCall: (facility: string, patient: string, moduleId: string) =>
    request<StartCallResult>(`/calls/`, "POST", {
      facility,
      patient,
      module_id: moduleId,
    }),

  /** CARE's own medication terminology, not ours. */
  medicationSearch: (search: string) =>
    coreRequest<{ results: ValueSetConcept[] }>(
      `/valueset/system-medication/expand/`,
      "POST",
      { search, count: 10 },
    ),
};
