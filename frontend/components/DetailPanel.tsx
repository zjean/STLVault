import React, { useState, useCallback, useRef, useEffect } from "react";
import { STLModel } from "../types";
import Viewer3D from "./Viewer3D";
import {
  X,
  Download,
  Save,
  Pencil,
  Trash2,
  Maximize2,
  RotateCcw,
  FileUp,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";

import { generateThumbnail } from "../services/thumbnailGenerator";
import { api } from "../services/api";
import ModelPrintsSection from "./custom-spoolman/ModelPrintsSection";

interface DetailPanelProps {
  model: STLModel | null;
  onClose: () => void;
  onUpdate: (id: string, updates: Partial<STLModel>) => void;
  onDelete: (id: string) => void;
}

const formatSize = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toUpperCase();
};

const baseName = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
};

const DetailPanel: React.FC<DetailPanelProps> = ({
  model,
  onClose,
  onUpdate,
  onDelete,
}) => {
  const [isReplacing, setIsReplacing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tempThumb, setTempThumb] = useState("");
  const [resetSignal, setResetSignal] = useState(0);
  const [errorState, setErrorState] = useState<{
    show: boolean;
    message: string;
  }>({ show: false, message: "" });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (model) {
      setEditName(baseName(model.name));
      setEditDesc(model.description || "");
      setTagInput("");
      setIsEditing(false);
      setIsReplacing(false);
      setTempThumb("");
      setErrorState({ show: false, message: "" });
    }
  }, [model?.id]);

  const handleModelLoaded = useCallback(
    (dimensions: { x: number; y: number; z: number }) => {
      if (model && !model.dimensions) {
        onUpdate(model.id, { dimensions });
      }
    },
    [model, onUpdate],
  );

  if (!model) return null;

  const currentExt = extOf(model.name);

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const newExt = extOf(file.name);
    if (currentExt && newExt && currentExt !== newExt) {
      setErrorState({
        show: true,
        message: `You cannot replace a .${currentExt.toLowerCase()} file with a .${newExt.toLowerCase()} file.`,
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsReplacing(true);
    try {
      let thumb: string | undefined;
      try {
        thumb = await generateThumbnail(file);
      } catch (err) {
        console.warn("Thumbnail failed", err);
      }
      const updated = await api.replaceModelFile(model.id, file, thumb);
      onUpdate(model.id, {
        url: updated.url,
        size: updated.size,
        thumbnail: updated.thumbnail,
      });
    } catch (err) {
      console.error("Failed to replace", err);
      alert("Failed to replace file");
    } finally {
      setIsReplacing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleReplaceThumbnail = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsReplacing(true);
    try {
      const updated = await api.replaceModelThumbnail(model.id, file);
      onUpdate(model.id, {
        url: updated.url,
        size: updated.size,
        thumbnail: updated.thumbnail,
      });
    } catch (err) {
      console.error("Failed to replace thumbnail", err);
      alert("Failed to replace thumbnail");
    } finally {
      setIsReplacing(false);
      if (thumbInputRef.current) thumbInputRef.current.value = "";
    }
  };

  const handleGenerateThumbnail = (dataurl: string) => setTempThumb(dataurl);

  const handleSave = () => {
    const nextName = editName.trim()
      ? currentExt
        ? `${editName.trim()}.${currentExt.toLowerCase()}`
        : editName.trim()
      : model.name;

    const updates: Partial<STLModel> = {
      name: nextName,
      description: editDesc,
    };
    if (tempThumb) updates.thumbnail = tempThumb;
    onUpdate(model.id, updates);
    setIsEditing(false);
  };

  const handleAddTagFromInput = () => {
    const raw = tagInput.trim().replace(/,$/, "");
    if (!raw) return;
    if (model.tags.includes(raw)) {
      setTagInput("");
      return;
    }
    onUpdate(model.id, { tags: [...model.tags, raw] });
    setTagInput("");
  };

  const handleRemoveTag = (tag: string) => {
    onUpdate(model.id, { tags: model.tags.filter((t) => t !== tag) });
  };

  return (
    <div className="w-screen sm:w-[420px] h-full bg-bg-2 border-l border-border flex flex-col shadow-drawer relative">
      {/* Head */}
      <div className="px-[22px] py-[14px] flex items-center border-b border-border-soft shrink-0">
        <h2 className="m-0 text-[14px] font-semibold -tracking-[0.005em] text-fg">
          Model details
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg transition-colors"
          aria-label="Close details"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-[22px] py-[18px] flex flex-col gap-[22px]">
        {/* Viewer */}
        <div
          className="relative h-[280px] shrink-0 rounded-[10px] border border-border-soft overflow-hidden grid place-items-center"
          style={{
            background:
              "radial-gradient(ellipse at 50% 95%, oklch(var(--accent) / 0.12), transparent 65%), linear-gradient(180deg, oklch(var(--bg)), oklch(var(--bg-3)))",
          }}
        >
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(oklch(var(--fg) / 0.04) 1px, transparent 1px), linear-gradient(90deg, oklch(var(--fg) / 0.04) 1px, transparent 1px)",
              backgroundSize: "32px 32px",
              maskImage:
                "radial-gradient(ellipse at center, black 40%, transparent 80%)",
              WebkitMaskImage:
                "radial-gradient(ellipse at center, black 40%, transparent 80%)",
            }}
          />
          <div className="absolute inset-0">
            <Viewer3D
              key={`${model.id}-${resetSignal}`}
              url={model.url}
              filename={model.name}
              thumbnail={model.thumbnail}
              editing={isEditing}
              onMakeThumbnail={handleGenerateThumbnail}
              onLoaded={handleModelLoaded}
            />
          </div>
          <div className="absolute top-2.5 right-2.5 flex gap-1 z-10">
            <button
              type="button"
              onClick={() => setResetSignal((s) => s + 1)}
              className="w-7 h-7 grid place-items-center rounded-md text-white/80 hover:text-white bg-black/40 hover:bg-black/60 backdrop-blur"
              aria-label="Reset view"
              title="Reset view"
            >
              <RotateCcw size={14} />
            </button>
          </div>
          <span className="absolute bottom-2.5 left-2.5 font-mono text-[10.5px] text-white/70 bg-black/40 backdrop-blur px-2 py-0.5 rounded z-10">
            Drag to rotate · scroll to zoom
          </span>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2">
          <a
            href={api.getDownloadUrl(model)}
            download={model.name}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all"
          >
            <Download size={15} /> Download
          </a>
          <a
            href={api.getSlicerUrl(model)}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 hover:border-fg-3 text-[13px] font-medium text-fg transition-colors"
          >
            <ExternalLink size={15} /> Open in slicer
          </a>
        </div>

        {/* Name + description */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
              Name
            </span>
            {!isEditing && (
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="text-[11.5px] text-fg-3 hover:text-fg inline-flex items-center gap-1"
                aria-label="Edit details"
              >
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>
          {isEditing ? (
            <div className="flex items-stretch gap-1">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Model name"
                className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all"
              />
              {currentExt && (
                <span className="self-center px-2 py-1 rounded bg-bg-3 font-mono text-[11px] text-fg-3">
                  .{currentExt.toLowerCase()}
                </span>
              )}
            </div>
          ) : (
            <p className="m-0 text-[14px] text-fg break-words">{model.name}</p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
            Description
          </span>
          {isEditing ? (
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder="Add a description…"
              rows={3}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all resize-y min-h-[60px]"
            />
          ) : (
            <p className="m-0 text-[13px] text-fg-2 break-words whitespace-pre-line">
              {model.description || (
                <span className="text-fg-3 italic">No description</span>
              )}
            </p>
          )}
        </section>

        {/* Tags */}
        <section className="flex flex-col gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
            Tags
          </span>
          <div className="flex flex-wrap gap-1.5 px-2.5 py-2 bg-surface border border-border rounded-lg items-center min-h-[38px]">
            {model.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded bg-accent/15 text-accent text-[11.5px]"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => handleRemoveTag(tag)}
                  className="w-3.5 h-3.5 grid place-items-center rounded hover:bg-accent/25 opacity-70 hover:opacity-100"
                  aria-label={`Remove tag ${tag}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            <input
              type="text"
              value={tagInput}
              onChange={(e) => {
                const v = e.target.value;
                if (v.endsWith(",")) {
                  setTagInput(v.slice(0, -1));
                  handleAddTagFromInput();
                } else {
                  setTagInput(v);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddTagFromInput();
                } else if (
                  e.key === "Backspace" &&
                  !tagInput &&
                  model.tags.length > 0
                ) {
                  handleRemoveTag(model.tags[model.tags.length - 1]);
                }
              }}
              onBlur={handleAddTagFromInput}
              placeholder={model.tags.length === 0 ? "Add tags…" : ""}
              className="flex-1 min-w-[80px] bg-transparent border-0 outline-none text-[12.5px] text-fg placeholder:text-fg-3"
            />
          </div>
        </section>

        {/* Metadata grid */}
        <section className="flex flex-col gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
            Metadata
          </span>
          <div className="grid grid-cols-2 gap-x-3.5 gap-y-3">
            <Field label="Format" value={currentExt || "—"} mono />
            <Field label="Size" value={formatSize(model.size)} mono />
            <Field
              label="Added"
              value={new Date(model.dateAdded).toLocaleDateString()}
            />
            <Field
              label="Dimensions"
              value={
                model.dimensions
                  ? `${model.dimensions.x.toFixed(1)} × ${model.dimensions.y.toFixed(1)} × ${model.dimensions.z.toFixed(1)} mm`
                  : "—"
              }
              mono
            />
            <FieldWide
              label="File ID"
              value={`${model.id}.${(currentExt || "").toLowerCase()}`}
              mono
              truncate
            />
            {model.sourceUrl && (
              <FieldWide
                label="Source"
                value={
                  <a
                    href={model.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline truncate inline-flex items-center gap-1"
                  >
                    <ExternalLink size={11} className="shrink-0" />
                    <span className="truncate">{model.sourceUrl}</span>
                  </a>
                }
                truncate
              />
            )}
          </div>
        </section>

        {/* Edit mode: file replacement */}
        {isEditing && (
          <section className="flex flex-col gap-3 pt-2 border-t border-border-soft">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
              File
            </span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isReplacing}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 hover:border-fg-3 text-[13px] font-medium text-fg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isReplacing ? (
                <RefreshCw size={15} className="animate-spin" />
              ) : (
                <FileUp size={15} />
              )}
              {isReplacing ? "Uploading…" : "Replace 3D file"}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".stl,.step,.stp,.3mf"
                onChange={handleReplaceFile}
              />
            </button>

            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3 mt-2">
              Thumbnail
            </span>
            {(tempThumb || model.thumbnail) && (
              <img
                src={tempThumb || model.thumbnail}
                alt="Current thumbnail"
                className="h-40 w-full object-contain rounded-lg bg-bg border border-border-soft"
              />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => thumbInputRef.current?.click()}
                disabled={isReplacing}
                className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] font-medium text-fg disabled:opacity-60"
              >
                <FileUp size={15} /> Replace
              </button>
              {tempThumb && (
                <button
                  type="button"
                  onClick={() => setTempThumb("")}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] text-fg-2"
                >
                  <X size={15} /> Clear
                </button>
              )}
              <input
                ref={thumbInputRef}
                type="file"
                className="hidden"
                accept=".jpeg,.png,.jpg"
                onChange={handleReplaceThumbnail}
              />
            </div>
          </section>
        )}

        {/* Save / cancel */}
        {isEditing && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all"
            >
              <Save size={15} /> Save changes
            </button>
            <button
              type="button"
              onClick={() => {
                setIsEditing(false);
                setEditName(baseName(model.name));
                setEditDesc(model.description || "");
                setTempThumb("");
              }}
              className="px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] text-fg-2"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Prints (fork addition) */}
        <ModelPrintsSection model={model} />

        {/* Danger zone */}
        <section className="mt-auto pt-3.5 border-t border-border-soft">
          <button
            type="button"
            onClick={() => {
              if (confirm(`Delete "${model.name}"? This cannot be undone.`)) {
                onDelete(model.id);
              }
            }}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-[13px] font-medium transition-colors text-danger bg-danger/15 border-danger/30 hover:bg-danger/25 hover:border-danger"
          >
            <Trash2 size={15} /> Delete model
          </button>
        </section>
      </div>

      {/* Error modal */}
      {errorState.show && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-[2px] p-6">
          <div className="bg-surface border border-danger/40 rounded-xl shadow-drawer p-5 max-w-sm w-full">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-12 h-12 rounded-full bg-danger/15 grid place-items-center">
                <AlertTriangle size={22} className="text-danger" />
              </div>
              <div>
                <h3 className="font-semibold text-fg m-0">File mismatch</h3>
                <p className="text-[13px] text-fg-2 mt-2 leading-relaxed">
                  {errorState.message}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setErrorState({ show: false, message: "" })}
                className="w-full mt-1 inline-flex items-center justify-center px-3 py-2 rounded-lg bg-bg-3 hover:bg-surface-2 text-[13px] font-medium text-fg transition-colors"
              >
                Okay, got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Field: React.FC<{
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}> = ({ label, value, mono = false }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[11.5px] text-fg-3">{label}</span>
    <span
      className={`text-[13px] text-fg break-words ${mono ? "font-mono text-[12px]" : ""}`}
    >
      {value}
    </span>
  </div>
);

const FieldWide: React.FC<{
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  truncate?: boolean;
}> = ({ label, value, mono = false, truncate = false }) => (
  <div className="col-span-2 flex flex-col gap-1 min-w-0">
    <span className="text-[11.5px] text-fg-3">{label}</span>
    <span
      className={`text-[13px] text-fg ${truncate ? "truncate" : "break-words"} ${
        mono ? "font-mono text-[12px]" : ""
      }`}
    >
      {value}
    </span>
  </div>
);

export default DetailPanel;
