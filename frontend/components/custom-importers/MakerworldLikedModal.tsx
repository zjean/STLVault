// Modal that lists the signed-in user's liked Makerworld designs and lets
// them multi-select for bulk import. Fork-only (custom-* path).
//
// Auth/expiry: re-uses the same red banner pattern as App.tsx's
// Import URL modal — when the backend returns the bambu_auth_expired
// 401, the catch block bubbles the typed error to the caller and the
// caller flips a flag that this modal renders as the banner.

import React, { useCallback, useEffect, useState } from "react";
import { Heart, X } from "lucide-react";
import {
  LikedDesign,
  makerworldApi,
  MakerworldAuthExpiredError,
} from "../../services/custom-importers";
import { Folder } from "../../types";

interface Props {
  open: boolean;
  onClose: () => void;
  folders: Folder[];
  defaultFolderId: string;
  onImport: (selected: LikedDesign[], folderId: string) => Promise<void>;
  bambuAuthExpired: boolean;
}

const PAGE_SIZE = 24;

const MakerworldLikedModal: React.FC<Props> = ({
  open,
  onClose,
  folders,
  defaultFolderId,
  onImport,
  bambuAuthExpired,
}) => {
  const [items, setItems] = useState<LikedDesign[]>([]);
  const [total, setTotal] = useState(0);
  const [hiddenCnt, setHiddenCnt] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [folderId, setFolderId] = useState(defaultFolderId);
  const [importing, setImporting] = useState(false);

  // Reset state every time the modal opens. Closing leaves state intact
  // briefly while the close animation could run; the next open resets.
  useEffect(() => {
    if (!open) return;
    setItems([]);
    setTotal(0);
    setHiddenCnt(0);
    setOffset(0);
    setSelected(new Set());
    setFolderId(defaultFolderId);
    setErrorMsg(null);
    setAuthExpired(bambuAuthExpired);
    setImporting(false);
  }, [open, defaultFolderId, bambuAuthExpired]);

  const loadPage = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const res = await makerworldApi.listLiked(PAGE_SIZE, nextOffset);
        setItems((prev) => (nextOffset === 0 ? res.hits : [...prev, ...res.hits]));
        setTotal(res.total);
        setHiddenCnt(res.hiddenCnt);
        setOffset(nextOffset + res.hits.length);
      } catch (e) {
        if (e instanceof MakerworldAuthExpiredError) {
          setAuthExpired(true);
        } else {
          setErrorMsg(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Initial fetch on open (and any time auth changes from expired → not).
  useEffect(() => {
    if (open && !authExpired && items.length === 0 && !loading) {
      loadPage(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authExpired]);

  const toggle = (designId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(designId)) next.delete(designId);
      else next.add(designId);
      return next;
    });
  };

  const hasMore = items.length < total;

  const handleImport = async () => {
    if (selected.size === 0 || !folderId) return;
    const picked = items.filter((d) => selected.has(d.designId));
    setImporting(true);
    try {
      await onImport(picked, folderId);
      onClose();
    } catch (e) {
      // Caller surfaces auth expiry by flipping the prop; other errors
      // we leave on screen so the user can decide whether to retry.
      if (e instanceof MakerworldAuthExpiredError) {
        setAuthExpired(true);
      } else {
        setErrorMsg(e instanceof Error ? e.message : "Import failed");
      }
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex justify-center items-center p-4">
      <div className="relative bg-vault-800 border border-vault-600 rounded-xl p-6 w-full lg:w-3/4 xl:w-2/3 shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center mb-4 shrink-0">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Heart className="w-5 h-5 text-red-400" />
            Browse Makerworld Liked
            {total > 0 && (
              <span className="text-sm font-normal text-slate-400">
                ({items.length}/{total}
                {hiddenCnt > 0 ? ` · ${hiddenCnt} hidden` : ""})
              </span>
            )}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {authExpired && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-700/50 rounded-lg text-sm text-red-200 shrink-0">
            <p className="font-semibold mb-1">Bambu Cloud sign-in required</p>
            <p className="text-red-300/90">
              Open Settings &rarr; Bambu Cloud and sign in to browse your
              liked designs.
            </p>
          </div>
        )}

        {errorMsg && !authExpired && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-700/50 rounded-lg text-sm text-red-200 shrink-0">
            {errorMsg}
          </div>
        )}

        <div className="flex-1 overflow-y-auto -mx-2 px-2">
          {items.length === 0 && !loading && !authExpired && !errorMsg && (
            <div className="text-center text-slate-500 py-12">
              No liked designs to show.
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
            {items.map((d) => {
              const isSelected = selected.has(d.designId);
              return (
                <button
                  key={d.designId}
                  type="button"
                  onClick={() => toggle(d.designId)}
                  disabled={!d.isPrintable}
                  className={`text-left bg-vault-900 border rounded-lg overflow-hidden transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                    isSelected
                      ? "border-blue-500 ring-2 ring-blue-500/50"
                      : "border-vault-700 hover:border-vault-600"
                  }`}
                >
                  <div className="aspect-square bg-vault-900 relative">
                    {d.coverUrl ? (
                      <img
                        src={d.coverUrl}
                        alt={d.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-600 text-xs">
                        no preview
                      </div>
                    )}
                    {isSelected && (
                      <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-blue-500 text-white text-xs flex items-center justify-center font-bold">
                        ✓
                      </div>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="text-sm text-white truncate" title={d.title}>
                      {d.title}
                    </p>
                    {d.creatorHandle && (
                      <p className="text-xs text-slate-500 truncate">
                        by {d.creatorHandle}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {hasMore && !authExpired && (
            <div className="flex justify-center pt-4 pb-2">
              <button
                onClick={() => loadPage(offset)}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-vault-700 hover:bg-vault-600 text-slate-200 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "Loading…" : `Load more (${total - items.length} left)`}
              </button>
            </div>
          )}
          {loading && items.length === 0 && (
            <div className="text-center text-slate-500 py-12">Loading…</div>
          )}
        </div>

        <div className="mt-4 shrink-0 border-t border-vault-700 pt-4 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Destination folder
            </label>
            <select
              className="w-full bg-vault-900 border border-vault-700 rounded-md px-3 py-2 text-white focus:border-indigo-500 outline-none text-sm"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
            >
              <option value="" disabled>
                Select a folder…
              </option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 sm:items-end">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 sm:flex-initial px-4 py-2 rounded-lg bg-vault-700 hover:bg-vault-600 text-slate-200 font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={
                selected.size === 0 || !folderId || authExpired || importing
              }
              className="flex-1 sm:flex-initial px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importing ? "Importing…" : `Import ${selected.size || ""}`.trim()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MakerworldLikedModal;
