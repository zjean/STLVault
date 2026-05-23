// Typed client for /api/makerworld/auth/* routes (fork-only).
//
// Bambu Cloud auth is a prerequisite for any Bambu-API feature, not
// specifically for Makerworld imports — that's why this lives under
// custom-bambu/, not custom-importers/. When V2 grows another
// Bambu-API feature (printer monitoring, etc.) it shares this module.

import { resolveApiBase } from "../apiBase";

export interface BambuAuthStatus {
  signedIn: boolean;
  signedInAs: string | null;
  accessExpiresAt: number | null; // unix ms
  expired: boolean;
}

export interface BambuLoginResult {
  signedInAs: string;
  accessExpiresAt: number;
}

export interface PasteTokenInput {
  accessToken: string;
  refreshToken?: string;
  accountEmail?: string;
}

export class BambuAuthApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function extractError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data === "object") {
      const d = (data as { detail?: unknown }).detail;
      if (typeof d === "string") return d;
      if (d && typeof d === "object" && typeof (d as { error?: string }).error === "string") {
        return (d as { error: string }).error;
      }
    }
  } catch {
    // fall through
  }
  return `Bambu Cloud returned HTTP ${res.status}`;
}

export const bambuAuth = {
  async sendCode(email: string): Promise<void> {
    const res = await fetch(`${resolveApiBase()}/makerworld/auth/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
  },

  async login(email: string, code: string): Promise<BambuLoginResult> {
    const res = await fetch(`${resolveApiBase()}/makerworld/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
    return res.json();
  },

  async getStatus(): Promise<BambuAuthStatus> {
    const res = await fetch(`${resolveApiBase()}/makerworld/auth/status`);
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
    return res.json();
  },

  async signOut(): Promise<void> {
    const res = await fetch(`${resolveApiBase()}/makerworld/auth/sign-out`, {
      method: "POST",
    });
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
  },

  async pasteToken(input: PasteTokenInput): Promise<BambuLoginResult> {
    const res = await fetch(`${resolveApiBase()}/makerworld/auth/paste-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
    return res.json();
  },
};
