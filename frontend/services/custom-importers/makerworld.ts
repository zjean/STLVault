// Typed client for /api/makerworld/{options,importid,liked} (fork-only).
// Mirrors the shape of api.retrieveModelOptions / api.importModelFromId
// so the URL-import flow can dispatch by hostname without changing the
// callers' signatures.

import { STLModel, STLModelCollection } from "../../types";

export interface LikedDesign {
  designId: number;
  modelId: string;
  title: string;
  slug: string;
  coverUrl: string;
  creatorHandle: string;
  isPrintable: boolean;
  nsfw: boolean;
  webUrl: string;
}

export interface LikedListResponse {
  hits: LikedDesign[];
  total: number;
  hiddenCnt: number;
}

const apiBase = (): string => {
  const override = localStorage.getItem("api-port-override");
  if (override) return override + "/api";
  return import.meta.env.VITE_API_URL + "/api";
};

export class MakerworldAuthExpiredError extends Error {
  constructor() {
    super("Bambu Cloud sign-in expired");
    this.name = "MakerworldAuthExpiredError";
  }
}

const isAuthExpired = (data: unknown): boolean => {
  if (!data || typeof data !== "object") return false;
  const detail = (data as { detail?: unknown }).detail;
  if (!detail || typeof detail !== "object") return false;
  return (detail as { error?: string }).error === "bambu_auth_expired";
};

export const makerworldApi = {
  async listLiked(limit = 24, offset = 0): Promise<LikedListResponse> {
    const res = await fetch(
      `${apiBase()}/makerworld/liked?limit=${limit}&offset=${offset}`,
    );
    if (res.status === 401) {
      const data = await res.json().catch(() => null);
      if (isAuthExpired(data)) throw new MakerworldAuthExpiredError();
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(
        (data as { detail?: string })?.detail ||
          `Makerworld /liked HTTP ${res.status}`,
      );
    }
    return res.json();
  },

  async retrieveModelOptions(url: string): Promise<STLModelCollection[]> {
    const res = await fetch(`${apiBase()}/makerworld/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(
        (data as { detail?: string })?.detail || `Makerworld /options HTTP ${res.status}`,
      );
    }
    return res.json();
  },

  async importModelFromId(
    id: string,
    name: string,
    parentId: string,
    previewPath: string,
    folderId: string,
    typeName: string,
    sourceUrl?: string,
  ): Promise<STLModel> {
    const res = await fetch(`${apiBase()}/makerworld/importid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, parentId, previewPath, folderId, typeName, sourceUrl }),
    });
    if (res.status === 401) {
      const data = await res.json().catch(() => null);
      if (isAuthExpired(data)) {
        throw new MakerworldAuthExpiredError();
      }
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(
        (data as { detail?: string })?.detail || `Makerworld /importid HTTP ${res.status}`,
      );
    }
    return res.json();
  },
};
