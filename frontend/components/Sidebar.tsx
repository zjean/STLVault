import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Folder as FolderIcon,
  Plus,
  Box,
  LayoutGrid,
  Pencil,
  Trash2,
  ChevronRight,
  Settings as SettingsIcon,
  Clock,
  Tag,
} from "lucide-react";
import { Folder, STLModel, StorageStats } from "../types";

const APP_TAG = import.meta.env.VITE_APP_TAG || "dev";

interface SidebarProps {
  folders: Folder[];
  models: STLModel[];
  currentFolderId: string;
  storageStats: StorageStats;
  onSelectFolder: (id: string) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (id: string, newName: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveToFolder: (folderId: string, modelIds: string[]) => void;
  onUploadToFolder: (folderId: string, files: FileList) => void;
  variant?: "desktop" | "mobile";
}

const Sidebar: React.FC<SidebarProps> = ({
  folders,
  models,
  currentFolderId,
  storageStats,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveToFolder,
  onUploadToFolder,
  variant = "desktop",
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const isDesktopVariant = variant === "desktop";
  const onLibraryRoute = location.pathname === "/";
  const onSettingsRoute = location.pathname === "/settings";
  const onRecentRoute = location.pathname === "/recent";

  const todayCount = useMemo(() => {
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const t = today0.getTime();
    return models.reduce((acc, m) => (m.dateAdded >= t ? acc + 1 : acc), 0);
  }, [models]);

  // Tree interaction state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [creatingParentId, setCreatingParentId] = useState<string | null | undefined>(undefined);
  const [creatingName, setCreatingName] = useState("");
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);

  // Desktop resize
  const [width, setWidth] = useState(268);
  const [isResizing, setIsResizing] = useState(false);

  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    models.forEach((m) => {
      counts[m.folderId] = (counts[m.folderId] || 0) + 1;
    });
    folders.forEach((f) => {
      if (f.parentId) counts[f.parentId] = (counts[f.parentId] || 0) + 1;
    });
    return counts;
  }, [models, folders]);

  const childrenByParent = useMemo(() => {
    const map: Record<string, Folder[]> = {};
    folders.forEach((f) => {
      const key = f.parentId ?? "__root__";
      (map[key] ||= []).push(f);
    });
    Object.values(map).forEach((list) =>
      list.sort((a, b) => a.name.localeCompare(b.name)),
    );
    return map;
  }, [folders]);

  const rootFolders = childrenByParent["__root__"] ?? [];

  // Resize handlers (desktop only)
  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      if (!isDesktopVariant) return;
      e.preventDefault();
      setIsResizing(true);
    },
    [isDesktopVariant],
  );

  useEffect(() => {
    if (!isDesktopVariant || !isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      setWidth(Math.min(Math.max(e.clientX, 220), 420));
    };
    const handleMouseUp = () => setIsResizing(false);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
    };
  }, [isResizing, isDesktopVariant]);

  // Auto-expand the path to the current folder
  useEffect(() => {
    if (!currentFolderId || currentFolderId === "all") return;
    const expandPath = (id: string, path: Set<string>) => {
      const folder = folders.find((f) => f.id === id);
      if (folder && folder.parentId) {
        path.add(folder.parentId);
        expandPath(folder.parentId, path);
      }
    };
    setExpandedIds((prev) => {
      const next = new Set(prev);
      expandPath(currentFolderId, next);
      return next;
    });
  }, [currentFolderId, folders]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startRename = (folder: Folder) => {
    setEditingId(folder.id);
    setEditingName(folder.name);
  };
  const commitRename = () => {
    if (editingId && editingName.trim()) {
      onRenameFolder(editingId, editingName.trim());
    }
    setEditingId(null);
    setEditingName("");
  };

  const startCreate = (parentId: string | null) => {
    setCreatingParentId(parentId);
    setCreatingName("");
    if (parentId) {
      setExpandedIds((prev) => new Set(prev).add(parentId));
    }
  };
  const commitCreate = () => {
    if (creatingName.trim() && creatingParentId !== undefined) {
      onCreateFolder(creatingName.trim(), creatingParentId);
    }
    setCreatingParentId(undefined);
    setCreatingName("");
  };
  const cancelCreate = () => {
    setCreatingParentId(undefined);
    setCreatingName("");
  };

  const requestDelete = (id: string, count: number) => {
    if (count > 0) {
      alert("Folder must be empty to delete (no files and no subfolders).");
      return;
    }
    onDeleteFolder(id);
  };

  // Drag-drop
  const handleDragOver = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragTargetId !== folderId) setDragTargetId(folderId);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragTargetId(null);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadToFolder(folderId, e.dataTransfer.files);
      return;
    }
    try {
      const data = e.dataTransfer.getData("application/json");
      if (data) {
        const { modelIds } = JSON.parse(data);
        if (Array.isArray(modelIds) && modelIds.length > 0) {
          onMoveToFolder(folderId, modelIds);
        }
      }
    } catch (err) {
      console.error("Failed to process drop", err);
    }
  };

  // Storage
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };
  const percentUsed =
    storageStats.total > 0
      ? Math.min((storageStats.used / storageStats.total) * 100, 100)
      : 0;

  // InlineEditor moved to module scope — defining it inside the component made
  // React remount the <input> on every parent render (new function reference
  // = new component type), which dropped focus mid-typing and broke commit.

  const TreeRow: React.FC<{ folder: Folder; depth: number }> = ({ folder, depth }) => {
    const childList = childrenByParent[folder.id] ?? [];
    const hasChildren = childList.length > 0;
    const isOpen = expandedIds.has(folder.id);
    const isSelected = currentFolderId === folder.id && onLibraryRoute;
    const isEditing = editingId === folder.id;
    const isDropTarget = dragTargetId === folder.id;
    const count = folderCounts[folder.id] || 0;
    const isCreatingHere = creatingParentId === folder.id;

    return (
      <div>
        <div
          className={[
            "group/row flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
            isSelected
              ? "bg-accent/15 text-accent"
              : "text-fg-2 hover:bg-bg-3 hover:text-fg",
            isDropTarget ? "ring-1 ring-accent/60 bg-accent/10" : "",
          ].join(" ")}
          onClick={() => {
            if (!onLibraryRoute) navigate("/");
            onSelectFolder(folder.id);
          }}
          onDragOver={(e) => handleDragOver(e, folder.id)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, folder.id)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) toggleExpand(folder.id);
            }}
            className={`w-3.5 h-3.5 grid place-items-center text-fg-3 shrink-0 ${
              hasChildren ? "" : "invisible"
            }`}
            aria-label={isOpen ? "Collapse folder" : "Expand folder"}
            tabIndex={hasChildren ? 0 : -1}
          >
            <ChevronRight
              size={12}
              className={`transition-transform ${isOpen ? "rotate-90" : ""}`}
            />
          </button>
          <FolderIcon
            size={14}
            className={isSelected ? "text-accent shrink-0" : "text-fg-3 shrink-0"}
          />
          {isEditing ? (
            <InlineEditor
              value={editingName}
              placeholder="Folder name"
              onChange={setEditingName}
              onCommit={commitRename}
              onCancel={() => {
                setEditingId(null);
                setEditingName("");
              }}
            />
          ) : (
            <span className="flex-1 min-w-0 truncate text-[13px]">
              {folder.name}
            </span>
          )}
          {!isEditing && (
            <>
              <span
                className={`font-mono text-[10.5px] text-fg-3 transition-opacity group-hover/row:opacity-0 ${
                  isSelected ? "text-accent" : ""
                }`}
              >
                {count > 0 ? count : ""}
              </span>
              <div className="absolute-not flex gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity -mr-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(folder);
                  }}
                  className="w-[22px] h-[22px] grid place-items-center rounded text-fg-3 hover:bg-bg-2 hover:text-fg"
                  aria-label="Rename folder"
                  title="Rename"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    startCreate(folder.id);
                  }}
                  className="w-[22px] h-[22px] grid place-items-center rounded text-fg-3 hover:bg-bg-2 hover:text-fg"
                  aria-label="Add subfolder"
                  title="New subfolder"
                >
                  <Plus size={12} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    requestDelete(folder.id, count);
                  }}
                  className="w-[22px] h-[22px] grid place-items-center rounded text-fg-3 hover:bg-danger/15 hover:text-danger"
                  aria-label="Delete folder"
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </>
          )}
        </div>
        {isOpen && (hasChildren || isCreatingHere) && (
          <div className="pl-[18px] flex flex-col gap-px">
            {childList.map((child) => (
              <TreeRow key={child.id} folder={child} depth={depth + 1} />
            ))}
            {isCreatingHere && (
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <span className="w-3.5 h-3.5 shrink-0" />
                <FolderIcon size={14} className="text-fg-3 shrink-0" />
                <InlineEditor
                  value={creatingName}
                  placeholder="New folder"
                  onChange={setCreatingName}
                  onCommit={commitCreate}
                  onCancel={cancelCreate}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const navItemClass = (active: boolean, disabled = false) =>
    [
      "flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13.5px] w-full text-left transition-colors",
      active
        ? "bg-accent/15 text-accent font-medium"
        : disabled
          ? "text-fg-3 opacity-50 cursor-not-allowed"
          : "text-fg-2 hover:bg-bg-3 hover:text-fg",
    ].join(" ");

  return (
    <div
      className="bg-bg-2 border-r border-border flex flex-col h-full min-h-0 select-none relative shrink-0"
      style={isDesktopVariant ? { width } : undefined}
      onDragLeave={() => setDragTargetId(null)}
    >
      {/* Head */}
      <div className="px-[18px] pt-[18px] pb-[14px] flex items-center gap-2.5 border-b border-border-soft">
        <div
          className="w-[30px] h-[30px] rounded-lg grid place-items-center shrink-0 shadow-soft"
          style={{
            background:
              "linear-gradient(140deg, oklch(var(--accent)), oklch(0.5 0.12 var(--accent-h)))",
            color: "oklch(var(--accent-fg))",
          }}
        >
          <Box size={18} />
        </div>
        <span className="font-semibold text-[15px] -tracking-[0.01em] text-fg">
          STL Vault
        </span>
        <span className="font-mono text-[10px] text-fg-3 bg-bg-3 px-1.5 py-0.5 rounded ml-auto">
          v{APP_TAG}
        </span>
      </div>

      {/* Top nav */}
      <div className="px-3 pt-3.5 pb-1.5 flex flex-col gap-0.5">
        <button
          type="button"
          className={navItemClass(onLibraryRoute && currentFolderId === "all")}
          onClick={() => {
            if (!onLibraryRoute) navigate("/");
            onSelectFolder("all");
          }}
        >
          <LayoutGrid size={16} />
          <span className="flex-1 text-left">All Models</span>
          <span
            className={`ml-auto font-mono text-[11px] px-1.5 py-px rounded min-w-[22px] text-center ${
              onLibraryRoute && currentFolderId === "all"
                ? "bg-accent/15 text-accent"
                : "bg-bg-3 text-fg-3"
            }`}
          >
            {models.length}
          </span>
        </button>
        <button
          type="button"
          className={navItemClass(onRecentRoute)}
          onClick={() => navigate("/recent")}
        >
          <Clock size={16} />
          <span className="flex-1 text-left">Recent</span>
          {todayCount > 0 && (
            <span
              className={`ml-auto font-mono text-[11px] px-1.5 py-px rounded min-w-[22px] text-center ${
                onRecentRoute
                  ? "bg-accent/15 text-accent"
                  : "bg-bg-3 text-fg-3"
              }`}
            >
              {todayCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className={navItemClass(false, true)}
          disabled
          title="Coming soon"
        >
          <Tag size={16} />
          <span className="flex-1 text-left">Tags</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-3">
            Soon
          </span>
        </button>
        <button
          type="button"
          className={navItemClass(onSettingsRoute)}
          onClick={() => navigate("/settings")}
        >
          <SettingsIcon size={16} />
          <span className="flex-1 text-left">Settings</span>
        </button>
      </div>

      {/* Library label */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between text-[10.5px] uppercase tracking-[0.08em] text-fg-3">
        <button
          type="button"
          onClick={() => setLibraryCollapsed((c) => !c)}
          className="flex items-center gap-1.5 px-2 py-1.5 hover:text-fg-2 transition-colors"
        >
          <ChevronRight
            size={12}
            className={`transition-transform ${libraryCollapsed ? "" : "rotate-90"}`}
          />
          Library
        </button>
        <button
          type="button"
          onClick={() => startCreate(null)}
          className="w-6 h-6 grid place-items-center rounded text-fg-3 hover:bg-bg-3 hover:text-fg transition-colors"
          aria-label="New root folder"
          title="New root folder"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Tree */}
      <div
        className={`flex-1 overflow-y-auto px-3 flex flex-col gap-px ${
          libraryCollapsed ? "hidden" : ""
        }`}
      >
        {creatingParentId === null && (
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <span className="w-3.5 h-3.5 shrink-0" />
            <FolderIcon size={14} className="text-fg-3 shrink-0" />
            <InlineEditor
              value={creatingName}
              placeholder="New folder"
              onChange={setCreatingName}
              onCommit={commitCreate}
              onCancel={cancelCreate}
            />
          </div>
        )}
        {rootFolders.length === 0 && creatingParentId === undefined && (
          <p className="px-2 py-2 text-[12px] text-fg-3">
            No folders yet. Click + to create one.
          </p>
        )}
        {rootFolders.map((folder) => (
          <TreeRow key={folder.id} folder={folder} depth={0} />
        ))}
      </div>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-border-soft">
        <div className="p-3 bg-bg-3 border border-border-soft rounded-lg">
          <div className="flex justify-between items-baseline mb-2">
            <span className="text-[12px] text-fg-2 font-medium">Storage</span>
            <span className="font-mono text-[11px] text-fg-3">
              {formatSize(storageStats.used)}
              {storageStats.total > 0 ? ` / ${formatSize(storageStats.total)}` : ""}
            </span>
          </div>
          <div className="h-[5px] rounded-pill overflow-hidden bg-fg/10">
            <div
              className="h-full rounded-pill transition-[width] duration-500"
              style={{
                width: `${percentUsed}%`,
                background:
                  "linear-gradient(90deg, oklch(var(--accent)), oklch(0.7 0.16 calc(var(--accent-h) + 30)))",
              }}
            />
          </div>
        </div>
      </div>

      {/* Resizer */}
      {isDesktopVariant && (
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 transition-colors ${
            isResizing ? "bg-accent" : "bg-transparent hover:bg-accent/40"
          }`}
          onMouseDown={startResizing}
        />
      )}
    </div>
  );
};

const InlineEditor: React.FC<{
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}> = ({ value, placeholder, onChange, onCommit, onCancel, autoFocus = true }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 min-w-0 bg-surface border border-accent rounded px-1.5 py-0.5 text-[13px] text-fg outline-none focus:ring-2 focus:ring-accent/30"
    />
  );
};

export default Sidebar;
