// Typed client for /api/makerworld/auth/* routes (fork-only).
//
// Bambu Cloud auth is a prerequisite for any Bambu-API feature, not
// specifically for Makerworld imports — that's why this lives under
// custom-bambu/, not custom-importers/. When V2 grows another
// Bambu-API feature (printer monitoring, etc.) it shares this module.

const apiBase = (): string => {
  const override = localStorage.getItem("api-port-override");
  if (override) return override + "/api";
  return import.meta.env.VITE_API_URL + "/api";
};

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
    const res = await fetch(`${apiBase()}/makerworld/auth/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
  },

  async login(email: string, code: string): Promise<BambuLoginResult> {
    const res = await fetch(`${apiBase()}/makerworld/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
    return res.json();
  },

  async getStatus(): Promise<BambuAuthStatus> {
    const res = await fetch(`${apiBase()}/makerworld/auth/status`);
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
    return res.json();
  },

  async signOut(): Promise<void> {
    const res = await fetch(`${apiBase()}/makerworld/auth/sign-out`, {
      method: "POST",
    });
    if (!res.ok) throw new BambuAuthApiError(res.status, await extractError(res));
  },
};
