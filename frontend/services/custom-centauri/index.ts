// Fork-only: typed client for /api/centauri/* (Centauri Carbon integration).

import { resolveApiBase } from "../apiBase";

export interface CentauriSettings {
  printerIp: string | null;
  printerName: string | null;
  printerUuid: string | null;
  autoConfirmEnabled: boolean;
  lastConnectedAt: number | null;
}

export interface CentauriStatus {
  connected: boolean;
  printerIp: string | null;
  mainboardId: string | null;
  lastConnectedAt: number | null;
  lastError: string | null;
  currentStatusCode: number | null;
  currentFilename: string | null;
  currentProgress: number | null;
  currentTaskId: string | null;
}

export interface PrintEvent {
  id: number;
  printerId: string;
  sdcpJobId: string;
  gcodeFilename: string;
  startedAt: number;
  endedAt: number | null;
  outcome: "completed" | "failed" | "cancelled";
  estTimeMin: number | null;
  actTimeMin: number | null;
  estFilamentG: number | null;
  actFilamentG: number | null;
  plateCount: number | null;
  embeddedMeshCount: number | null;
  plateTransformsIdentity: boolean | null;
  thumbnailPath: string | null;
  archived3mfPath: string | null;
  // Phase-2.2 enrichment fields — populated when the printer's gcode
  // was fetched + parsed after the terminal-state transition. All
  // nullable; old events never had these computed.
  archivedGcodePath?: string | null;
  gcodeMd5?: string | null;
  taskName?: string | null;
  inputFilenameBase?: string | null;
  rawPayloadParsed: Record<string, unknown> | null;
  createdAt: number;
}

export interface PrintReview {
  eventId: number;
  reviewedAt: number;
  action: "confirm" | "dismiss" | "reassign" | "create" | "reserve" | "auto";
  reason: string | null;
  resultingPrintId: string | null;
  resultingModelId: string | null;
}

export interface MatchCandidate {
  id: number;
  eventId: number;
  modelId: string;
  signal:
    | "filename"
    | "printer_filename"
    | "source_hash"
    | "recent_slicer_open";
  confidence: number;
  reason: string | null;
  modelName: string | null;
  modelThumbnail: string | null;
}

export interface PrintEventWithCandidates extends PrintEvent {
  candidates: MatchCandidate[];
  // Review row when present — null for never-reviewed events. Reserved
  // events have `review.action === 'reserve'` (non-terminal).
  review?: PrintReview | null;
  // `reservedAt` is populated only on the /reserves response. Optional
  // because the same type also represents inbox events (no reserve row).
  reservedAt?: number;
}

export interface DiscoveredPrinter {
  host: string;
  mainboardId: string | null;
  name: string | null;
  machineName: string | null;
  firmwareVersion: string | null;
}

export interface TestConnectionResult {
  ok: boolean;
  mainboard_id: string | null;
  error: string | null;
}

export class CentauriApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "CentauriApiError";
  }
}

const apiBase = (): string => resolveApiBase();

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new CentauriApiError(
      body?.detail || `Centauri ${res.status}`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

export const centauriApi = {
  async getSettings(): Promise<CentauriSettings> {
    return jsonOrThrow(await fetch(`${apiBase()}/centauri/settings`));
  },

  async saveSettings(patch: Partial<CentauriSettings>): Promise<CentauriSettings> {
    return jsonOrThrow(
      await fetch(`${apiBase()}/centauri/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },

  async getStatus(): Promise<CentauriStatus> {
    return jsonOrThrow(await fetch(`${apiBase()}/centauri/status`));
  },

  async testConnection(ip: string): Promise<TestConnectionResult> {
    return jsonOrThrow(
      await fetch(`${apiBase()}/centauri/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip }),
      }),
    );
  },

  async discover(): Promise<DiscoveredPrinter[]> {
    return jsonOrThrow(
      await fetch(`${apiBase()}/centauri/discover`, { method: "POST" }),
    );
  },

  async listEvents(reviewed?: boolean, limit = 100): Promise<PrintEventWithCandidates[]> {
    const params = new URLSearchParams();
    if (reviewed !== undefined) params.set("reviewed", String(reviewed));
    params.set("limit", String(limit));
    return jsonOrThrow(
      await fetch(`${apiBase()}/centauri/events?${params}`),
    );
  },

  async getEvent(id: number): Promise<{
    event: PrintEvent;
    review: PrintReview | null;
    candidates: MatchCandidate[];
  }> {
    return jsonOrThrow(await fetch(`${apiBase()}/centauri/events/${id}`));
  },

  thumbnailUrl(eventId: number): string {
    return `${apiBase()}/centauri/events/${eventId}/thumbnail`;
  },

  async review(
    eventId: number,
    action: "confirm" | "dismiss" | "reserve",
    opts: { modelId?: string; reason?: string } = {},
  ): Promise<PrintReview> {
    return jsonOrThrow(
      await fetch(`${apiBase()}/centauri/events/${eventId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...opts }),
      }),
    );
  },

  async listReserves(sinceDays = 30): Promise<PrintEventWithCandidates[]> {
    const params = new URLSearchParams();
    params.set("since_days", String(sinceDays));
    return jsonOrThrow(
      await fetch(`${apiBase()}/centauri/reserves?${params}`),
    );
  },

  // EventSource is browser-native; wrapper just centralises the URL.
  streamUrl(): string {
    return `${apiBase()}/centauri/events/stream`;
  },
};
