// Fork-only: typed client for the Spoolman proxy + settings endpoints
// served by backend/custom_routes/spoolman.py.
//
// Mirrors the resolution logic in services/api.ts (localStorage override
// > VITE_API_URL > /api in `npm run dev`). Duplicating ~10 lines is
// cheaper than restructuring api.ts to export the resolved base.

let API_BASE_URL = "";
const override = localStorage.getItem("api-port-override");
if (override) {
  API_BASE_URL = override + "/api";
} else if (import.meta.env.VITE_API_URL === "TERA_API_URL") {
  API_BASE_URL = "/api";
} else {
  API_BASE_URL = import.meta.env.VITE_API_URL + "/api";
}

const BASE = `${API_BASE_URL}/spoolman`;

// ---- shapes ----

export interface SpoolmanSettings {
  baseUrl: string | null;
  enabled: boolean;
  hasApiKey: boolean;
}

export interface SpoolmanTestResult {
  ok: boolean;
  version?: string;
  error?: string;
  status?: number;
}

export interface SpoolSummary {
  id: number;
  label: string;
  filamentName: string;
  vendorName: string | null;
  material: string | null;
  colorHex: string | null;
  remainingWeight: number | null;
  usedWeight: number | null;
  remainingLength: number | null;
  location: string | null;
  lotNr: string | null;
  archived: boolean;
}

export interface SliceParseResult {
  source: string;
  estWeightG: number | null;
  estLengthMm: number | null;
  estDurationMin: number | null;
  filamentColorHex: string | null;
  empty: boolean;
}

// ---- error helper ----

export class SpoolmanApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "SpoolmanApiError";
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return res.json() as Promise<T>;
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.detail) detail = body.detail;
  } catch {
    /* non-JSON body — keep the HTTP code */
  }
  throw new SpoolmanApiError(res.status, detail);
}

// ---- API ----

export const spoolmanApi = {
  getSettings: async (): Promise<SpoolmanSettings> => {
    return jsonOrThrow(await fetch(`${BASE}/settings`));
  },

  saveSettings: async (input: {
    baseUrl: string | null;
    apiKey?: string | null;
    enabled: boolean;
  }): Promise<SpoolmanSettings> => {
    return jsonOrThrow(
      await fetch(`${BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },

  testConnection: async (input?: {
    baseUrl?: string | null;
    apiKey?: string | null;
  }): Promise<SpoolmanTestResult> => {
    return jsonOrThrow(
      await fetch(`${BASE}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? {}),
      }),
    );
  },

  listSpools: async (): Promise<SpoolSummary[]> => {
    return jsonOrThrow(await fetch(`${BASE}/spools`));
  },

  getSpool: async (id: number): Promise<unknown> => {
    return jsonOrThrow(await fetch(`${BASE}/spools/${id}`));
  },

  parseSliceUpload: async (file: File): Promise<SliceParseResult> => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonOrThrow(
      await fetch(`${BASE}/parse-slice`, { method: "POST", body: fd }),
    );
  },

  parseSliceForModel: async (modelId: string): Promise<SliceParseResult> => {
    return jsonOrThrow(
      await fetch(
        `${BASE}/parse-slice?modelId=${encodeURIComponent(modelId)}`,
        { method: "POST" },
      ),
    );
  },
};
