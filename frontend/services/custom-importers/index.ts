// Host-based dispatch for URL-import: picks Printables or Makerworld
// (or fails-soft to Printables) based on the hostname of the pasted URL.
// Re-exports MakerworldAuthExpiredError so callers can branch on it
// without depending on the makerworld module directly.

import { api } from "../api";
import { STLModel, STLModelCollection } from "../../types";
import { makerworldApi, MakerworldAuthExpiredError } from "./makerworld";

export { MakerworldAuthExpiredError };

const isMakerworld = (url: string): boolean => {
  try {
    return new URL(url).hostname.endsWith("makerworld.com");
  } catch {
    return false;
  }
};

export const retrieveModelOptionsByHost = (
  url: string,
): Promise<STLModelCollection[]> =>
  isMakerworld(url)
    ? makerworldApi.retrieveModelOptions(url)
    : api.retrieveModelOptions(url);

export const importModelFromIdByHost = (
  sourceHost: string,
  id: string,
  name: string,
  parentId: string,
  previewPath: string,
  folderId: string,
  typeName: string,
): Promise<STLModel> =>
  isMakerworld(sourceHost)
    ? makerworldApi.importModelFromId(
        id,
        name,
        parentId,
        previewPath,
        folderId,
        typeName,
      )
    : api.importModelFromId(id, name, parentId, previewPath, folderId, typeName);
