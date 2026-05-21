// Modal that lists the signed-in user's liked Makerworld designs and lets
// them multi-select for bulk import. Fork-only (custom-* path).
//
// Auth/expiry: when the backend returns the bambu_auth_expired 401, the
// caller flips a flag we render as the danger-toned banner.

import React, { useCallback, useEffect, useState } from "react";
import { Heart, FileBox, Check } from "lucide-react";
import {
  LikedDesign,
  makerworldApi,
  MakerworldAuthExpiredError,
} from "../../services/custom-importers";
import { Folder } from "../../types";
import Dialog from "../Dialog";

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

  // Reset state every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setItems([]);
    setTotal(0);
    setHiddenCnt(0);
    setOffset(0);
    setSelected(new Set());
    setFolderId(defaultFolderId || "all");
    setErrorMsg(null);
    setAuthExpired(bambuAuthExpired);
    setImporting(false);
  }, [open, defaultFolderId, bambuAuthExpired]);

  const loadPage = useCallback(async (nextOffset: number) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await makerworldApi.listLiked(PAGE_SIZE, nextOffset);
      setItems((prev) =>
        nextOffset === 0 ? res.hits : [...prev, ...res.hits],
      );
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
  }, []);

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

  const titleSuffix =
    total > 0 ? (
      <span className="font-mono text-[11px] text-fg-3 ml-1">
        ({items.length}/{total}
        {hiddenCnt > 0 ? ` · ${hiddenCnt} hidden` : ""})
      </span>
    ) : null;

  return (
    <Dialog
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-1.5">
          Browse Makerworld Liked
          {titleSuffix}
        </span>
      }
      icon={<Heart size={16} />}
      size="md"
      noBodyScroll
    >
      <div className="flex flex-col flex-1 min-h-0">
        {(authExpired || errorMsg) && (
          <div className="px-5 pt-4 shrink-0">
            {authExpired && (
              <div className="px-3.5 py-2.5 rounded-lg bg-danger-soft border border-danger/40 border-l-[3px] border-l-danger text-[12.5px]">
                <p className="font-semibold text-fg mb-0.5">
                  Bambu Cloud sign-in required
                </p>
                <p className="text-fg-2">
                  Open Settings → Bambu Cloud and sign in to browse your liked
                  designs.
                </p>
              </div>
            )}
            {errorMsg && !authExpired && (
              <div className="px-3.5 py-2.5 rounded-lg bg-danger-soft border border-danger/40 border-l-[3px] border-l-danger text-[12.5px] text-fg-2">
                {errorMsg}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {items.length === 0 && !loading && !authExpired && !errorMsg && (
            <div className="text-[13px] text-fg-3 text-center py-12">
              No liked designs to show.
            </div>
          )}

          {items.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {items.map((d) => {
                const isSelected = selected.has(d.designId);
                return (
                  <button
                    key={d.designId}
                    type="button"
                    onClick={() => toggle(d.designId)}
                    disabled={!d.isPrintable}
                    className={`text-left rounded-card overflow-hidden border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                      isSelected
                        ? "border-accent bg-accent/5"
                        : "border-border-soft bg-surface hover:border-border"
                    }`}
                  >
                    <div
                      className="aspect-square relative"
                      style={{
                        background:
                          "radial-gradient(ellipse at 50% 100%, oklch(var(--accent) / 0.08), transparent 60%), linear-gradient(180deg, oklch(var(--bg-2)), oklch(var(--bg-3)))",
                      }}
                    >
                      {d.coverUrl ? (
                        <img
                          src={d.coverUrl}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="absolute inset-0 grid place-items-center text-fg-3">
                          <FileBox size={28} />
                        </div>
                      )}
                      {isSelected && (
                        <span
                          className="absolute top-2 right-2 w-5 h-5 rounded-full grid place-items-center bg-accent text-accent-fg"
                          aria-hidden
                        >
                          <Check size={11} />
                        </span>
                      )}
                    </div>
                    <div className="px-2.5 py-2">
                      <p
                        className="text-[13px] font-medium text-fg truncate"
                        title={d.title}
                      >
                        {d.title}
                      </p>
                      {d.creatorHandle && (
                        <p className="font-mono text-[11px] text-fg-3 truncate">
                          by {d.creatorHandle}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {hasMore && !authExpired && (
            <div className="flex justify-center pt-4 pb-1">
              <button
                type="button"
                onClick={() => loadPage(offset)}
                disabled={loading}
                className="px-3.5 py-1.5 rounded-md border border-border-soft text-[13px] text-fg-2 hover:bg-bg-3 hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading
                  ? "Loading…"
                  : `Load more (${total - items.length} left)`}
              </button>
            </div>
          )}
          {loading && items.length === 0 && (
            <div className="text-[13px] text-fg-3 text-center py-12">
              Loading…
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-border-soft flex flex-col sm:flex-row gap-3 sm:items-end shrink-0">
          <label className="flex-1 block">
            <span className="block text-[12.5px] text-fg-3 mb-1.5">
              Destination folder
            </span>
            <select
              className="w-full bg-surface border border-border-soft rounded-md px-3 py-2 text-[13px] text-fg focus:border-accent outline-none transition-colors"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
            >
              <option value="all">All Models (root)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 justify-end shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-md border border-border-soft text-fg-2 text-[13px] hover:bg-bg-3 hover:text-fg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={
                selected.size === 0 || !folderId || authExpired || importing
              }
              className="px-3.5 py-1.5 rounded-md bg-accent text-accent-fg text-[13px] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {importing
                ? "Importing…"
                : `Import${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
};

export default MakerworldLikedModal;
