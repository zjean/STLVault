// Fork-only: typed client for the STLVault prints API.

let API_BASE_URL = "";
const override = localStorage.getItem("api-port-override");
if (override) {
  API_BASE_URL = override + "/api";
} else if (import.meta.env.VITE_API_URL === "TERA_API_URL") {
  API_BASE_URL = "/api";
} else {
  API_BASE_URL = import.meta.env.VITE_API_URL + "/api";
}

export type PrintStatus = "printing" | "completed" | "failed" | "cancelled";

export interface PrintFilament {
  id: string;
  printId: string;
  spoolId: number;
  estWeightG: number | null;
  usedWeightG: number | null;
  estLengthMm: number | null;
  usedLengthMm: number | null;
  spoolLabel: string | null;
  filamentColor: string | null;
  consumedAt: number | null;
}

export interface Print {
  id: string;
  modelId: string;
  status: PrintStatus;
  startedAt: number | null;
  completedAt: number | null;
  estDurationMin: number | null;
  wallClockMin: number | null;
  printer: string | null;
  notes: string | null;
  syncedToSpoolman: boolean;
  createdAt: number;
  filaments: PrintFilament[];
  // Provenance: "manual" for prints logged via the dialog, "centauri" for
  // prints written by the Centauri ingest path. centauriEventId is the
  // soft FK into centauri_print_event when source === "centauri".
  source?: "manual" | "centauri";
  centauriEventId?: number | null;
}

export interface SyncResult {
  synced: boolean;
  spoolUpdates: { spoolId: number; remainingWeight: number | null }[];
  error: string | null;
  failedSpoolId?: number | null;
}

export interface CreatePrintInput {
  status: PrintStatus;
  filaments: {
    spoolId: number;
    estWeightG?: number | null;
    usedWeightG?: number | null;
    estLengthMm?: number | null;
    usedLengthMm?: number | null;
  }[];
  startedAt?: number | null;
  completedAt?: number | null;
  estDurationMin?: number | null;
  wallClockMin?: number | null;
  printer?: string | null;
  notes?: string | null;
}

export interface CompletePrintInput {
  status?: PrintStatus;
  filaments?: {
    spoolId: number;
    // Send the filament row id from the existing print when known —
    // disambiguates same-spool-twice legs and survives multi-spool UI.
    filamentRowId?: string;
    usedWeightG?: number | null;
    usedLengthMm?: number | null;
  }[];
  completedAt?: number | null;
  wallClockMin?: number | null;
  notes?: string | null;
}

export class PrintsApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "PrintsApiError";
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return res.json() as Promise<T>;
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.detail) detail = body.detail;
  } catch {
    /* non-JSON body */
  }
  throw new PrintsApiError(res.status, detail);
}

export const printsApi = {
  listForModel: async (modelId: string): Promise<Print[]> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/models/${modelId}/prints`)),

  createForModel: async (
    modelId: string,
    body: CreatePrintInput,
  ): Promise<{ print: Print; sync: SyncResult }> =>
    jsonOrThrow(
      await fetch(`${API_BASE_URL}/models/${modelId}/prints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),

  complete: async (
    printId: string,
    body: CompletePrintInput,
  ): Promise<{ print: Print; sync: SyncResult }> =>
    jsonOrThrow(
      await fetch(`${API_BASE_URL}/prints/${printId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),

  resync: async (
    printId: string,
  ): Promise<{ print: Print; sync: SyncResult }> =>
    jsonOrThrow(
      await fetch(`${API_BASE_URL}/prints/${printId}/resync`, {
        method: "POST",
      }),
    ),

  delete: async (printId: string): Promise<{ ok: boolean; wasSynced: boolean }> =>
    jsonOrThrow(
      await fetch(`${API_BASE_URL}/prints/${printId}`, { method: "DELETE" }),
    ),

  listAll: async (params?: {
    limit?: number;
    offset?: number;
    status?: PrintStatus;
    spoolId?: number;
    modelId?: string;
    sinceMs?: number;
    untilMs?: number;
  }): Promise<Print[]> => {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set("limit", String(params.limit));
    if (params?.offset != null) qs.set("offset", String(params.offset));
    if (params?.status) qs.set("status", params.status);
    if (params?.spoolId != null) qs.set("spoolId", String(params.spoolId));
    if (params?.modelId) qs.set("modelId", params.modelId);
    if (params?.sinceMs != null) qs.set("sinceMs", String(params.sinceMs));
    if (params?.untilMs != null) qs.set("untilMs", String(params.untilMs));
    const url = `${API_BASE_URL}/prints${qs.toString() ? `?${qs}` : ""}`;
    return jsonOrThrow(await fetch(url));
  },

  rollup: async (sinceMs: number, untilMs?: number): Promise<{
    count: number;
    totalMinutes: number;
    totalWeightG: number;
  }> => {
    const qs = new URLSearchParams({ sinceMs: String(sinceMs) });
    if (untilMs != null) qs.set("untilMs", String(untilMs));
    return jsonOrThrow(
      await fetch(`${API_BASE_URL}/prints/stats/rollup?${qs.toString()}`),
    );
  },
};
