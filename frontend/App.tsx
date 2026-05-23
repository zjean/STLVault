import React, { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import ModelList from "./components/ModelList";
import DetailPanel from "./components/DetailPanel";
import Settings from "./components/Settings";
import RecentView from "./components/RecentView";
import TagsView from "./components/TagsView";
import TagDetailView from "./components/TagDetailView";
import Dialog from "./components/Dialog";
import ImportOptionsBody from "./components/ImportOptionsBody";
import { STLModel, Folder, StorageStats, STLModelCollection } from "./types";
import { generateThumbnail } from "./services/thumbnailGenerator";
import { api } from "./services/api";
import {
  retrieveModelOptionsByHost,
  importModelFromIdByHost,
  MakerworldAuthExpiredError,
  LikedDesign,
} from "./services/custom-importers";
import MakerworldLikedModal from "./components/custom-importers/MakerworldLikedModal";
import PrintsHistoryView from "./components/custom-spoolman/PrintsHistoryView";
import InboxView from "./components/custom-centauri/InboxView";
import PostUploadLinkDialog from "./components/custom-centauri/PostUploadLinkDialog";
import {
  centauriApi,
  PrintEventWithCandidates,
} from "./services/custom-centauri";
import {
  FolderInput,
  Tags,
  X,
  Trash2,
  AlertTriangle,
  Download,
  FileUp,
  Globe,
} from "lucide-react";
import JSZip from "jszip";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useVisualViewport } from "./hooks/useVisualViewport";
const App = () => {
  const isDesktop = useMediaQuery("(min-width: 1024px)", true);
  const isMobile = !isDesktop;
  const visualViewport = useVisualViewport();
  // Theme follows the data-theme attribute on <html>. Settings updates both
  // this state and the attribute.
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.getAttribute("data-theme") === "light"
      ? "light"
      : "dark",
  );
  const applyTheme = (next: "dark" | "light") => {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("stlvault-theme", next);
  };
  const [folders, setFolders] = useState<Folder[]>([]);
  const [models, setModels] = useState<STLModel[]>([]);
  const [storageStats, setStorageStats] = useState<StorageStats>({
    used: 0,
    total: 0,
  });

  // Centauri reserve-for-upload follow-up: after an upload batch, if any
  // events are sitting in `reserve` state we offer a one-shot link dialog.
  const [reserveLinkDialog, setReserveLinkDialog] = useState<{
    uploadedModels: STLModel[];
    reserves: PrintEventWithCandidates[];
  } | null>(null);

  const [currentFolderId, setCurrentFolderId] = useState<string>("all");
  const [currentFolderParentId, setCurrentFolderParentId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<number>(0);
  const location = useLocation();
  const navigate = useNavigate();
  const showSettings = location.pathname === "/settings";
  const showRecent = location.pathname === "/recent";
  const showTags = location.pathname === "/tags";
  const showPrints = location.pathname === "/prints";
  const showInbox = location.pathname === "/inbox";
  const tagDetailMatch = location.pathname.match(/^\/tags\/(.+)$/);
  const showTagDetail = !!tagDetailMatch;
  const currentTagName = tagDetailMatch
    ? decodeURIComponent(tagDetailMatch[1])
    : null;
  const [librarySearchSeed, setLibrarySearchSeed] = useState("");
  const openSettings = () => navigate("/settings");
  const closeSettings = () => navigate("/");
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isMobileSidebarMounted, setIsMobileSidebarMounted] = useState(false);
  const [isMobileSidebarVisible, setIsMobileSidebarVisible] = useState(false);

  // Bulk Action State
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);
  const [bulkTags, setBulkTags] = useState("");

  // Upload Modal State
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadFolderId, setUploadFolderId] = useState("");
  const [uploadTags, setUploadTags] = useState("");

  // Import Modal State
  const [showImportModal, setShowImportModal] = useState(false);
  const [showImportOptionsModal, setShowImportOptionsModal] = useState(false);
  const [modelsOptions, setModelsOptions] = useState<STLModelCollection[]>([]);
  const [folderOptions, setFolderOptions] = useState<Set<string>>(new Set());
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(
    new Set(),
  );
  const [importUrl, setImportUrl] = useState("");
  const [importFolderId, setImportFolderId] = useState("");
  const [bambuAuthExpired, setBambuAuthExpired] = useState(false);
  const [showLikedModal, setShowLikedModal] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const port = import.meta.env.VITE_API_URL;
  // Delete Confirmation State
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    isOpen: boolean;
    type: "single" | "bulk" | "folder";
    id?: string;
  }>({ isOpen: false, type: "single" });

  // Initial Data Fetch
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [fetchedFolders, fetchedModels, fetchedStats] = await Promise.all(
          [api.getFolders(), api.getModels("all"), api.getStorageStats()],
        );
        setFolders(fetchedFolders);
        setModels(fetchedModels);
        setStorageStats(fetchedStats);
      } catch (error) {
        console.error("Failed to fetch initial data:", error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, []);

  // Refresh storage stats when models change (upload, delete, replace)
  useEffect(() => {
    api
      .getStorageStats()
      .then(setStorageStats)
      .catch((e) => console.error("Failed to refresh storage stats", e));
  }, [models]);

  // Filter models based on selection
  const filteredModels =
    currentFolderId === "all"
      ? models
      : models.filter((m) => m.folderId === currentFolderId);

  // Filter subfolders based on selection
  const filteredFolders =
    currentFolderId === "all"
      ? folders.filter((f) => f.parentId == null)
      : folders.filter((f) => f.parentId === currentFolderId);

  // Clear selection when changing folders to avoid confusion
  useEffect(() => {
    setSelectedIds(new Set());
    setCurrentFolderParentId(
      currentFolderId === "all"
        ? "all"
        : folders.find((f) => f.id === currentFolderId)?.parentId || "all",
    );
  }, [currentFolderId]);

  // Close mobile sidebar when switching to desktop
  useEffect(() => {
    if (isDesktop) setIsMobileSidebarOpen(false);
  }, [isDesktop]);

  // Close mobile sidebar on any route change
  useEffect(() => {
    setIsMobileSidebarOpen(false);
  }, [location.pathname]);

  // Mobile sidebar animation: keep mounted during close transition
  useEffect(() => {
    const transitionMs = 220;
    let timeoutId: number | undefined;

    if (isMobileSidebarOpen) {
      setIsMobileSidebarMounted(true);
      // Delay visibility to allow initial off-screen position to render before sliding in
      timeoutId = window.setTimeout(() => setIsMobileSidebarVisible(true), 10);
    } else {
      setIsMobileSidebarVisible(false);
      timeoutId = window.setTimeout(
        () => setIsMobileSidebarMounted(false),
        transitionMs,
      );
    }

    return () => {
      if (typeof timeoutId === "number") window.clearTimeout(timeoutId);
    };
  }, [isMobileSidebarOpen]);

  // Mobile sidebar UX: ESC to close + prevent body scroll
  useEffect(() => {
    if (!isMobileSidebarMounted) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsMobileSidebarOpen(false);
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [isMobileSidebarMounted]);

  const selectedModel = models.find((m) => m.id === selectedModelId) || null;

  const currentFolderName =
    currentFolderId === "all"
      ? "All Models"
      : folders.find((f) => f.id === currentFolderId)?.name || "Folder";

  const handleCreateFolder = async (
    name: string,
    parentId: string | null = null,
  ) => {
    try {
      const newFolder = await api.createFolder(name, parentId);
      setFolders((prev) => [...prev, newFolder]);
      // If created under a parent, ensure parent is expanded in Sidebar (Sidebar handles its own expansion state, but good to know)
    } catch (error) {
      console.error("Failed to create folder:", error);
    }
  };

  const handleRenameFolder = async (id: string, newName: string) => {
    try {
      await api.updateFolder(id, newName);
      setFolders((prev) =>
        prev.map((f) => (f.id === id ? { ...f, name: newName } : f)),
      );
    } catch (error) {
      console.error("Failed to rename folder", error);
    }
  };

  const handleDeleteFolder = (id: string) => {
    const hasModels = models.some((m) => m.folderId === id);
    const hasSubfolders = folders.some((f) => f.parentId === id);

    if (hasModels || hasSubfolders) {
      alert(
        "Folder must be empty to delete. Please delete or move all models and subfolders first.",
      );
      return;
    }
    setDeleteConfirmState({ isOpen: true, type: "folder", id });
  };

  // Core upload logic
  const executeUpload = async (
    files: File[],
    targetFolderId: string,
    tags: string[],
  ) => {
    setUploadQueue((prev) => prev + files.length);
    const uploaded: STLModel[] = [];

    for (const file of files) {
      try {
        let thumbnail: string | undefined = undefined;
        try {
          thumbnail = await generateThumbnail(file);
        } catch (e) {
          console.warn(
            "Thumbnail generation failed, uploading without thumbnail",
          );
        }

        const newModel = await api.uploadModel(
          file,
          targetFolderId,
          thumbnail,
          tags,
        );
        setModels((prev) => [newModel, ...prev]);
        uploaded.push(newModel);
      } catch (error) {
        console.error(`Failed to upload ${file.name}:`, error);
      } finally {
        setUploadQueue((prev) => prev - 1);
      }
    }

    // Post-upload: if any Centauri events are reserved and waiting for
    // a model to land, offer a one-shot link dialog. Soft-fails — the
    // backend may be unreachable, the printer may not be configured, etc;
    // none of those should block the upload UX.
    if (uploaded.length > 0) {
      try {
        const reserves = await centauriApi.listReserves();
        if (reserves.length > 0) {
          setReserveLinkDialog({ uploadedModels: uploaded, reserves });
        }
      } catch (e) {
        // Quiet — no toast infrastructure to surface this and it's
        // strictly opt-in.
        console.debug("centauri reserves probe failed:", e);
      }
    }
  };

  const handleUpload = async (
    fileList: FileList,
    specificFolderId?: string,
  ) => {
    const files = Array.from(fileList);

    // If dropping into the general area ("all") and not a specific folder drop
    // We want to show the modal to let user pick a folder and add tags
    if (!specificFolderId && currentFolderId === "all") {
      setPendingFiles(files);
      // Default to first folder if available; otherwise root ("all").
      setUploadFolderId(folders.length > 0 ? folders[0].id : "all");
      setUploadTags("");
      setShowUploadModal(true);
      return;
    }

    // Normal flow (specific folder target or current view is a folder)
    const targetFolderId = specificFolderId || currentFolderId;

    // Fallback if for some reason 'all' is passed without modal (shouldn't happen with above check)
    const finalFolderId =
      targetFolderId === "all" && folders.length > 0
        ? folders[0].id
        : targetFolderId;

    await executeUpload(files, finalFolderId, []);
  };

  const handleConfirmUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFolderId) return;

    const tags = uploadTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    setShowUploadModal(false);
    await executeUpload(pendingFiles, uploadFolderId, tags);
    setPendingFiles([]);
  };

  const handleOpenImport = () => {
    setImportUrl("");
    setSelectedOptions(new Set());
    setModelsOptions([]);
    setImportError(null);
    setBambuAuthExpired(false);
    // Pre-select current folder if specific; otherwise first folder, else root.
    setImportFolderId(
      currentFolderId !== "all"
        ? currentFolderId
        : folders[0]?.id || "all",
    );
    setShowImportModal(true);
  };

  const handleOpenLiked = () => {
    setBambuAuthExpired(false);
    setImportError(null);
    setShowLikedModal(true);
  };

  // Per-design: fetch its instances and import them all. The webUrl
  // doubles as the sourceUrl on each created model row — the existing
  // host-based dispatch in importModelFromIdByHost handles routing to
  // the Makerworld importer and threading the source URL through.
  const handleLikedImport = async (
    picked: LikedDesign[],
    folderId: string,
  ) => {
    if (picked.length === 0 || !folderId) return;
    setIsLoading(true);
    setBambuAuthExpired(false);
    setImportError(null);
    const failures: string[] = [];
    try {
      for (const design of picked) {
        let instances;
        try {
          instances = await retrieveModelOptionsByHost(design.webUrl);
        } catch (e) {
          console.error(
            `liked import: failed to fetch instances for ${design.title}`,
            e,
          );
          failures.push(
            `${design.title}: ${e instanceof Error ? e.message : "fetch failed"}`,
          );
          continue;
        }
        setUploadQueue((prev) => prev + instances.length);
        for (const inst of instances) {
          try {
            const newModel = await importModelFromIdByHost(
              design.webUrl,
              inst.id,
              inst.name,
              inst.parentId,
              inst.previewPath,
              folderId,
              inst.typeName,
            );
            await handleUpdateSTEPThumbnail(newModel);
          } catch (e) {
            if (e instanceof MakerworldAuthExpiredError) {
              setBambuAuthExpired(true);
              setUploadQueue(0);
              throw e; // bubble up so the modal can show the banner
            }
            console.error(
              `liked import: failed to import instance ${inst.id} of ${design.title}`,
              e,
            );
            failures.push(
              `${design.title} / ${inst.name}: ${e instanceof Error ? e.message : "import failed"}`,
            );
          } finally {
            setUploadQueue((prev) => Math.max(0, prev - 1));
          }
        }
      }
      if (failures.length > 0) {
        const head = `${failures.length} import${failures.length === 1 ? "" : "s"} failed`;
        setImportError(`${head}\n${failures.slice(0, 3).join("\n")}${failures.length > 3 ? `\n…and ${failures.length - 3} more` : ""}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importUrl || !importFolderId) return;

    try {
      const ModelOptions = await retrieveModelOptionsByHost(importUrl);
      const NewSet = new Set("");
      ModelOptions.forEach((m) => {
        if (!NewSet.has(m.folder)) {
          NewSet.add(m.folder);
        }
      });
      setFolderOptions(NewSet);
      setModelsOptions(ModelOptions);
      setShowImportModal(false);
      setShowImportOptionsModal(true);
    } catch (error) {
      console.error("Import failed:", error);
      setImportError(
        error instanceof Error
          ? error.message
          : "Failed to import from URL",
      );
    }
  };

  const handleOptionsToggleSelection = (id: string) => {
    const newSet = new Set(selectedOptions);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedOptions(newSet);
  };

  const handleUpdateSTEPThumbnail = async (newModel: STLModel) => {
    let tbuff = await fetch(port + newModel.url).then((response) => {
      return response;
    });
    let thumbnailBuffer = await tbuff.bytes().then((bytes) => {
      return bytes;
    });
    try {
      let thumbnail = await generateThumbnail(
        new File([thumbnailBuffer], newModel.name),
      );
      let newerModel = await api.updateModel(newModel.id, {
        thumbnail: thumbnail,
      });
      setModels((prev) => [newerModel, ...prev]);
    } catch (e) {
      console.warn("Thumbnail generation failed, uploading without thumbnail");
    }
  };

  const handleImportChoice = async () => {
    if (!importUrl || !importFolderId) return;

    setIsLoading(true);
    setShowImportOptionsModal(false);
    setUploadQueue((prev) => prev + selectedOptions.size);
    setBambuAuthExpired(false);
    try {
      for (const model of modelsOptions) {
        if (selectedOptions.has(model.id)) {
          let newModel = await importModelFromIdByHost(
            importUrl,
            model.id,
            model.name,
            model.parentId,
            model.previewPath,
            importFolderId,
            model.typeName,
          );
          await handleUpdateSTEPThumbnail(newModel);
          setUploadQueue((prev) => prev - 1);
        }
      }
    } catch (error) {
      if (error instanceof MakerworldAuthExpiredError) {
        console.warn("Makerworld import: bambu auth expired");
        setBambuAuthExpired(true);
        setUploadQueue(0);
      } else {
        console.error("Import failed:", error);
        setImportError(
          error instanceof Error
            ? error.message
            : "Failed to import from URL",
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateModel = async (id: string, updates: Partial<STLModel>) => {
    try {
      setModels((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      );
      await api.updateModel(id, updates);
    } catch (error) {
      console.error("Failed to update model:", error);
    }
  };

  const handleDeleteModel = (id: string) => {
    console.log("Opening delete confirmation for model:", id);
    setDeleteConfirmState({ isOpen: true, type: "single", id });
  };

  const handleBulkDelete = () => {
    console.log("Opening bulk delete confirmation for:", selectedIds);
    setDeleteConfirmState({ isOpen: true, type: "bulk" });
  };

  const executeDelete = async () => {
    const { type, id } = deleteConfirmState;
    console.log(`Executing delete type: ${type}, id: ${id}`);

    try {
      if (type === "single" && id) {
        await api.deleteModel(id);
        setModels((prev) => prev.filter((m) => m.id !== id));
        if (selectedModelId === id) setSelectedModelId(null);
      } else if (type === "bulk") {
        const ids = Array.from(selectedIds) as string[];
        await api.bulkDeleteModels(ids);
        setModels((prev) => prev.filter((m) => !ids.includes(m.id)));
        setSelectedIds(new Set());
        if (selectedModelId && ids.includes(selectedModelId))
          setSelectedModelId(null);
      } else if (type === "folder" && id) {
        await api.deleteFolder(id);
        setFolders((prev) => prev.filter((f) => f.id !== id));
        if (currentFolderId === id) setCurrentFolderId("all");
      }
    } catch (error) {
      console.error("Delete operation failed:", error);
      alert("Failed to delete. Please check console.");
    } finally {
      setDeleteConfirmState((prev) => ({ ...prev, isOpen: false }));
    }
  };

  // --- Bulk Actions Logic ---

  const handleToggleSelection = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const handleSelectAll = (filtered) => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      const allIds = filtered.map((m) => m.id);
      setSelectedIds(new Set(allIds));
    }
  };

  const handleBulkMoveSubmit = async (targetFolderId: string) => {
    try {
      const ids = Array.from(selectedIds) as string[];
      await api.bulkMoveModels(ids, targetFolderId);
      setModels((prev) =>
        prev.map((m) =>
          selectedIds.has(m.id) ? { ...m, folderId: targetFolderId } : m,
        ),
      );
      setShowMoveModal(false);
      setSelectedIds(new Set());
    } catch (e) {
      console.error("Bulk move failed", e);
    }
  };

  const handleDropMove = async (targetFolderId: string, modelIds: string[]) => {
    try {
      await api.bulkMoveModels(modelIds, targetFolderId);
      setModels((prev) =>
        prev.map((m) =>
          modelIds.includes(m.id) ? { ...m, folderId: targetFolderId } : m,
        ),
      );
      setSelectedIds(new Set());
    } catch (e) {
      console.error("Drop move failed", e);
    }
  };

  const handleBulkTagSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const ids = Array.from(selectedIds) as string[];
      const tags = bulkTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await api.bulkAddTags(ids, tags);
      setModels((prev) =>
        prev.map((m) => {
          if (selectedIds.has(m.id)) {
            return { ...m, tags: [...new Set([...m.tags, ...tags])] };
          }
          return m;
        }),
      );
      setShowTagModal(false);
      setSelectedIds(new Set());
    } catch (err) {
      console.error("Bulk tag failed", err);
    }
  };

  const handleBulkDownload = async () => {
    setIsLoading(true);
    try {
      const zip = new JSZip();
      const selectedModels = models.filter((m) => selectedIds.has(m.id));

      // Add files to zip
      const filePromises = selectedModels.map(async (model) => {
        try {
          const url = api.getDownloadUrl(model);
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch ${model.name}`);
          const blob = await response.blob();
          zip.file(model.name, blob);
        } catch (err) {
          console.error(`Error downloading ${model.name} for zip:`, err);
        }
      });

      await Promise.all(filePromises);

      // Generate zip
      const content = await zip.generateAsync({ type: "blob" });
      const saveUrl = URL.createObjectURL(content);

      // Trigger download
      const link = document.createElement("a");
      link.href = saveUrl;
      link.download = `stlvault-batch-${new Date().getTime()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(saveUrl);

      // Clear selection
      setSelectedIds(new Set());
    } catch (error) {
      console.error("Bulk download failed:", error);
      alert("Failed to generate zip file.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <div
        className={`${
          isDesktop ? "flex" : "flex flex-col"
        } h-dvh text-fg font-sans selection:bg-accent/30 overflow-hidden`}
      >
        {isDesktop ? (
          <Sidebar
            folders={folders}
            models={models}
            currentFolderId={currentFolderId}
            storageStats={storageStats}
            onSelectFolder={(id) => {
              setCurrentFolderId(id);
              setSelectedModelId(null);
              closeSettings();
            }}
            onCreateFolder={handleCreateFolder}
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onMoveToFolder={handleDropMove}
            onUploadToFolder={(folderId, files) =>
              handleUpload(files, folderId)
            }
            variant="desktop"
          />
        ) : (
          <>
            {isMobileSidebarMounted && (
              <div className="fixed inset-0 z-[70]">
                <div
                  className={`absolute inset-0 bg-black/60 backdrop-blur-[2px] transition-opacity duration-200 ${
                    isMobileSidebarVisible ? "opacity-100" : "opacity-0"
                  }`}
                  onClick={() => setIsMobileSidebarOpen(false)}
                />
                <div
                  className={`absolute inset-y-0 left-0 w-[85vw] max-w-[360px] transform transition-transform duration-200 ease-out ${
                    isMobileSidebarVisible
                      ? "translate-x-0"
                      : "-translate-x-full"
                  }`}
                >
                  <Sidebar
                    folders={folders}
                    models={models}
                    currentFolderId={currentFolderId}
                    storageStats={storageStats}
                    onSelectFolder={(id) => {
                      setCurrentFolderId(id);
                      setSelectedModelId(null);
                      closeSettings();
                      setIsMobileSidebarOpen(false);
                    }}
                    onCreateFolder={handleCreateFolder}
                    onRenameFolder={handleRenameFolder}
                    onDeleteFolder={handleDeleteFolder}
                    onMoveToFolder={handleDropMove}
                    onUploadToFolder={(folderId, files) =>
                      handleUpload(files, folderId)
                    }
                    variant="mobile"
                  />
                </div>
              </div>
            )}
          </>
        )}

        {/* Settings View */}
        {showSettings ? (
          <Settings
            onBack={closeSettings}
            onOpenMobileSidebar={
              !isDesktop ? () => setIsMobileSidebarOpen(true) : undefined
            }
            theme={theme}
            onThemeChange={applyTheme}
          />
        ) : showRecent ? (
          <RecentView
            models={models}
            onBack={closeSettings}
            onOpenMobileSidebar={
              !isDesktop ? () => setIsMobileSidebarOpen(true) : undefined
            }
            onOpenModel={(m) => {
              setCurrentFolderId(m.folderId);
              setSelectedModelId(m.id);
              navigate("/");
            }}
          />
        ) : showTags ? (
          <TagsView
            models={models}
            onBack={closeSettings}
            onOpenMobileSidebar={
              !isDesktop ? () => setIsMobileSidebarOpen(true) : undefined
            }
          />
        ) : showPrints ? (
          <PrintsHistoryView
            models={models}
            onBack={closeSettings}
            onOpenMobileSidebar={
              !isDesktop ? () => setIsMobileSidebarOpen(true) : undefined
            }
            onOpenModel={(m) => {
              setCurrentFolderId(m.folderId);
              setSelectedModelId(m.id);
              navigate("/");
            }}
          />
        ) : showInbox ? (
          <InboxView
            models={models}
            onBack={closeSettings}
            onOpenMobileSidebar={
              !isDesktop ? () => setIsMobileSidebarOpen(true) : undefined
            }
          />
        ) : showTagDetail && currentTagName ? (
          <TagDetailView
            models={models}
            tagName={currentTagName}
            onBack={() => navigate("/tags")}
            onOpenMobileSidebar={
              !isDesktop ? () => setIsMobileSidebarOpen(true) : undefined
            }
            onOpenModel={(m) => {
              setCurrentFolderId(m.folderId);
              setSelectedModelId(m.id);
              navigate("/");
            }}
            onOpenInLibrary={(tag) => {
              setCurrentFolderId("all");
              setSelectedModelId(null);
              setLibrarySearchSeed(tag);
              navigate("/");
            }}
            onRenameTag={async (oldTag, newTag) => {
              const affected = models.filter((m) => m.tags.includes(oldTag));
              await Promise.all(
                affected.map((m) => {
                  const next = m.tags.filter((t) => t !== oldTag);
                  if (!next.includes(newTag)) next.push(newTag);
                  return api.updateModel(m.id, { tags: next });
                }),
              );
              const fresh = await api.getModels("all");
              setModels(fresh);
            }}
          />
        ) : (
          <>
            <main className="flex-1 flex overflow-hidden relative">
              {isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center bg-bg z-50">
                  <div className="flex flex-col items-center gap-4">
                    <div className="animate-spin rounded-full h-12 w-12 border-2 border-border border-t-accent"></div>
                    <p className="text-fg-3 animate-pulse">Processing…</p>
                  </div>
                </div>
              ) : (
                <ModelList
                  models={filteredModels}
                  folders={filteredFolders}
                  currentFolderName={currentFolderName}
                  initialSearch={librarySearchSeed}
                  onSearchConsumed={() => setLibrarySearchSeed("")}
                  onBackNavigation={() => {
                    setCurrentFolderId(currentFolderParentId);
                  }}
                  onUpload={(files) => handleUpload(files)}
                  onImport={handleOpenImport}
                  onBrowseLiked={handleOpenLiked}
                  onSelectModel={(m) => setSelectedModelId(m.id)}
                  onDelete={handleDeleteModel}
                  selectedModelId={selectedModelId}
                  onOpenMobileSidebar={
                    !isDesktop ? () => setIsMobileSidebarOpen(true) : undefined
                  }
                  // Selection Props
                  selectedIds={selectedIds}
                  onToggleSelection={handleToggleSelection}
                  onSelectAll={(filtered) => handleSelectAll(filtered)}
                  onClearSelection={() => setSelectedIds(new Set())}
                  onNavigateFolder={(id) => setCurrentFolderId(id)}
                  onMoveToFolder={handleDropMove}
                  onUploadToFolder={(folderId, files) =>
                    handleUpload(files, folderId)
                  }
                />
              )}

              {/* Upload Indicator */}
              {uploadQueue > 0 && (
                <div className="absolute bottom-6 left-6 bg-accent text-accent-fg px-4 py-2 rounded-lg shadow-lg z-50 flex items-center gap-3 animate-pulse">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-sm font-medium">
                    Uploading {uploadQueue} file(s)...
                  </span>
                </div>
              )}

              {/* Backdrop for closing sidebar */}
              <div
                className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] z-20 transition-opacity duration-300 ${
                  selectedModelId
                    ? "opacity-100 pointer-events-auto"
                    : "opacity-0 pointer-events-none"
                }`}
                onClick={() => setSelectedModelId(null)}
              />

              {/* Slide-over panel — right drawer on desktop, bottom sheet on mobile */}
              <div
                className={`absolute z-30 transition-transform duration-300 ease-out ${
                  isDesktop
                    ? `top-0 right-0 h-full ${selectedModelId ? "translate-x-0" : "translate-x-full"}`
                    : `inset-x-0 bottom-0 top-[60px] rounded-t-[20px] overflow-hidden border-t border-border ${selectedModelId ? "translate-y-0" : "translate-y-full"}`
                }`}
              >
                <DetailPanel
                  model={selectedModel}
                  onClose={() => setSelectedModelId(null)}
                  onUpdate={handleUpdateModel}
                  onDelete={handleDeleteModel}
                />
              </div>

              {/* Floating bulk-action bar — top-level z-index */}
              {selectedIds.size > 0 && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-surface border border-border shadow-drawer rounded-pill px-5 py-2.5 flex items-center gap-3 z-50">
                  <div className="flex items-center gap-2 border-r border-border-soft pr-3">
                    <span className="font-mono text-[13px] font-medium text-fg">
                      {selectedIds.size}
                    </span>
                    <span className="text-[12px] text-fg-3">selected</span>
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      className="ml-1 w-6 h-6 grid place-items-center rounded text-fg-3 hover:bg-bg-3 hover:text-fg transition-colors"
                      aria-label="Clear selection"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setShowMoveModal(true)}
                      className="px-2.5 py-1.5 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors flex items-center gap-1.5 text-[12.5px]"
                      title="Move selected"
                    >
                      <FolderInput className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Move</span>
                    </button>
                    <button
                      onClick={() => {
                        setBulkTags("");
                        setShowTagModal(true);
                      }}
                      className="px-2.5 py-1.5 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors flex items-center gap-1.5 text-[12.5px]"
                      title="Tag selected"
                    >
                      <Tags className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Tag</span>
                    </button>
                    <button
                      onClick={handleBulkDownload}
                      className="px-2.5 py-1.5 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors flex items-center gap-1.5 text-[12.5px]"
                      title="Download selected"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Download</span>
                    </button>
                    <button
                      onClick={handleBulkDelete}
                      className="px-2.5 py-1.5 rounded-md text-fg-2 hover:bg-danger/15 hover:text-danger transition-colors flex items-center gap-1.5 text-[12.5px]"
                      title="Delete selected"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Delete</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Modals Layer */}

              {/* Upload Modal */}
              {showUploadModal && (
                <Dialog
                  onClose={() => setShowUploadModal(false)}
                  title="Upload files"
                  icon={<FileUp size={16} />}
                >
                  <form onSubmit={handleConfirmUpload} className="px-5 py-5">
                    <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-bg-3 border border-border-soft">
                      <p className="text-[13px] text-fg font-medium">
                        {pendingFiles.length}{" "}
                        {pendingFiles.length === 1 ? "file" : "files"} selected
                      </p>
                      <p className="text-[11.5px] text-fg-3 truncate mt-0.5 font-mono">
                        {pendingFiles.map((f) => f.name).join(", ")}
                      </p>
                    </div>

                    <label className="block mb-4">
                      <span className="block text-[12.5px] text-fg-3 mb-1.5">
                        Destination folder
                      </span>
                      <select
                        className="w-full bg-surface border border-border-soft rounded-md px-3 py-2 text-[13px] text-fg focus:border-accent outline-none transition-colors"
                        value={uploadFolderId}
                        onChange={(e) => setUploadFolderId(e.target.value)}
                      >
                        <option value="all">All Models (root)</option>
                        {folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block mb-5">
                      <span className="block text-[12.5px] text-fg-3 mb-1.5">
                        Tags (optional)
                      </span>
                      <input
                        type="text"
                        className="w-full bg-surface border border-border-soft rounded-md px-3 py-2 text-[13px] text-fg placeholder:text-fg-3 focus:border-accent outline-none transition-colors"
                        placeholder="scifi, armor, weapon…"
                        value={uploadTags}
                        onChange={(e) => setUploadTags(e.target.value)}
                      />
                      <p className="text-[11.5px] text-fg-3 mt-1.5">
                        Separate tags with commas.
                      </p>
                    </label>

                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setShowUploadModal(false)}
                        className="px-3.5 py-1.5 rounded-md border border-border-soft text-fg-2 text-[13px] hover:bg-bg-3 hover:text-fg transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!uploadFolderId}
                        className="px-3.5 py-1.5 rounded-md bg-accent text-accent-fg text-[13px] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                      >
                        Upload
                      </button>
                    </div>
                  </form>
                </Dialog>
              )}

              {/* Import URL Modal */}
              {showImportModal && (
                <Dialog
                  onClose={() => setShowImportModal(false)}
                  title="Import from URL"
                  icon={<Globe size={16} />}
                >
                  <form onSubmit={handleImportSubmit} className="px-5 py-5">
                    <label className="block mb-4">
                      <span className="block text-[12.5px] text-fg-3 mb-1.5">
                        Model URL
                      </span>
                      <input
                        autoFocus
                        type="url"
                        required
                        className="w-full bg-surface border border-border-soft rounded-md px-3 py-2 text-[13px] text-fg placeholder:text-fg-3 focus:border-accent outline-none transition-colors"
                        placeholder="https://www.printables.com/model/… or https://makerworld.com/en/models/…"
                        value={importUrl}
                        onChange={(e) => setImportUrl(e.target.value)}
                      />
                      <p className="text-[11.5px] text-fg-3 mt-1.5">
                        Paste a link from Printables or Makerworld. Makerworld
                        downloads require a Bambu Cloud sign-in in Settings.
                      </p>
                    </label>

                    {bambuAuthExpired && (
                      <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft border border-danger/40 border-l-[3px] border-l-danger text-[12.5px]">
                        <p className="font-semibold text-fg mb-0.5">
                          Bambu Cloud sign-in required
                        </p>
                        <p className="text-fg-2">
                          Open Settings → Bambu Cloud and sign in (or
                          re-sign-in) to import from Makerworld.
                        </p>
                      </div>
                    )}

                    <label className="block mb-5">
                      <span className="block text-[12.5px] text-fg-3 mb-1.5">
                        Destination folder
                      </span>
                      <select
                        className="w-full bg-surface border border-border-soft rounded-md px-3 py-2 text-[13px] text-fg focus:border-accent outline-none transition-colors"
                        value={importFolderId}
                        onChange={(e) => setImportFolderId(e.target.value)}
                      >
                        <option value="all">All Models (root)</option>
                        {folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setShowImportModal(false)}
                        className="px-3.5 py-1.5 rounded-md border border-border-soft text-fg-2 text-[13px] hover:bg-bg-3 hover:text-fg transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!importUrl || !importFolderId}
                        className="px-3.5 py-1.5 rounded-md bg-accent text-accent-fg text-[13px] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                      >
                        Import
                      </button>
                    </div>
                  </form>
                </Dialog>
              )}

              {/* Import Options Modal */}
              <MakerworldLikedModal
                open={showLikedModal}
                onClose={() => setShowLikedModal(false)}
                folders={folders}
                defaultFolderId={
                  currentFolderId !== "all"
                    ? currentFolderId
                    : folders[0]?.id || "all"
                }
                onImport={handleLikedImport}
                bambuAuthExpired={bambuAuthExpired}
              />

              {showImportOptionsModal && (
                <Dialog
                  onClose={() => setShowImportOptionsModal(false)}
                  title="Select files to import"
                  icon={<Globe size={16} />}
                  size="md"
                  noBodyScroll
                >
                  <ImportOptionsBody
                    modelsOptions={modelsOptions}
                    selectedOptions={selectedOptions}
                    onToggle={handleOptionsToggleSelection}
                    onSelectAll={() =>
                      setSelectedOptions(
                        new Set(modelsOptions.map((m) => m.id)),
                      )
                    }
                    onClearAll={() => setSelectedOptions(new Set())}
                    onCancel={() => setShowImportOptionsModal(false)}
                    onImport={() => handleImportChoice()}
                  />
                </Dialog>
              )}

              {/* Delete Confirmation Modal */}
              {deleteConfirmState.isOpen && (
                <Dialog
                  onClose={() =>
                    setDeleteConfirmState((prev) => ({
                      ...prev,
                      isOpen: false,
                    }))
                  }
                  title="Confirm deletion"
                  icon={<AlertTriangle size={16} className="text-danger" />}
                >
                  <div className="px-5 py-5">
                    <div className="flex items-start gap-3 mb-5">
                      <div
                        className="w-10 h-10 rounded-full grid place-items-center bg-danger-soft shrink-0"
                        aria-hidden
                      >
                        <AlertTriangle size={18} className="text-danger" />
                      </div>
                      <p className="text-[13.5px] text-fg-2 leading-relaxed">
                        {deleteConfirmState.type === "single" &&
                          "Delete this model? This can't be undone."}
                        {deleteConfirmState.type === "bulk" &&
                          `Delete ${selectedIds.size} ${
                            selectedIds.size === 1 ? "model" : "models"
                          }? This can't be undone.`}
                        {deleteConfirmState.type === "folder" &&
                          "Delete this folder?"}
                      </p>
                    </div>

                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          setDeleteConfirmState((prev) => ({
                            ...prev,
                            isOpen: false,
                          }))
                        }
                        className="px-3.5 py-1.5 rounded-md border border-border-soft text-fg-2 text-[13px] hover:bg-bg-3 hover:text-fg transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={executeDelete}
                        className="px-3.5 py-1.5 rounded-md bg-danger text-white text-[13px] font-medium hover:opacity-90 transition-opacity"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </Dialog>
              )}

              {showMoveModal && (
                <Dialog
                  onClose={() => setShowMoveModal(false)}
                  title={`Move ${selectedIds.size} ${
                    selectedIds.size === 1 ? "model" : "models"
                  }`}
                  icon={<FolderInput size={16} />}
                >
                  <div className="px-5 py-4">
                    {folders.length === 0 ? (
                      <div className="text-[13px] text-fg-3 text-center py-6">
                        No folders yet. Create one in the sidebar first.
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {folders.map((folder) => (
                          <button
                            key={folder.id}
                            type="button"
                            onClick={() => handleBulkMoveSubmit(folder.id)}
                            className="w-full text-left px-3 py-2 rounded-md border border-transparent hover:border-border-soft hover:bg-bg-3 text-[13px] text-fg-2 hover:text-fg transition-colors"
                          >
                            {folder.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Dialog>
              )}

              {reserveLinkDialog && (
                <PostUploadLinkDialog
                  uploadedModels={reserveLinkDialog.uploadedModels}
                  reserves={reserveLinkDialog.reserves}
                  onClose={() => setReserveLinkDialog(null)}
                  onLinked={() => {
                    // Print logs were written backend-side; nothing to
                    // refresh in the library view itself. Recent/Prints
                    // panels refetch on next mount.
                  }}
                />
              )}

              {showTagModal && (
                <Dialog
                  onClose={() => setShowTagModal(false)}
                  title={`Add tags to ${selectedIds.size} ${
                    selectedIds.size === 1 ? "model" : "models"
                  }`}
                  icon={<Tags size={16} />}
                >
                  <form onSubmit={handleBulkTagSubmit} className="px-5 py-5">
                    <label className="block mb-5">
                      <span className="block text-[12.5px] text-fg-3 mb-1.5">
                        Tags
                      </span>
                      <input
                        autoFocus
                        type="text"
                        className="w-full bg-surface border border-border-soft rounded-md px-3 py-2 text-[13px] text-fg placeholder:text-fg-3 focus:border-accent outline-none transition-colors"
                        placeholder="scifi, armor, weapon…"
                        value={bulkTags}
                        onChange={(e) => setBulkTags(e.target.value)}
                      />
                      <p className="text-[11.5px] text-fg-3 mt-1.5">
                        Separate tags with commas.
                      </p>
                    </label>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setShowTagModal(false)}
                        className="px-3.5 py-1.5 rounded-md border border-border-soft text-fg-2 text-[13px] hover:bg-bg-3 hover:text-fg transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-3.5 py-1.5 rounded-md bg-accent text-accent-fg text-[13px] font-medium hover:opacity-90 transition-opacity"
                      >
                        Add tags
                      </button>
                    </div>
                  </form>
                </Dialog>
              )}
            </main>
          </>
        )}
      </div>
      {!port && (
        <div
          role="alert"
          aria-live="polite"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] px-4 py-2.5 rounded-md bg-danger text-white text-[13px] font-medium shadow-lifted"
        >
          API host not set
        </div>
      )}
      {importError && (
        <div
          role="alert"
          aria-live="polite"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] max-w-[560px] w-[calc(100%-2rem)] px-4 py-3 rounded-lg bg-danger-soft border border-danger/40 border-l-[3px] border-l-danger shadow-lifted flex items-start gap-3"
        >
          <div className="flex-1 min-w-0 text-[12.5px] text-fg-2 whitespace-pre-line break-words">
            <p className="font-semibold text-fg mb-0.5">Import failed</p>
            {importError}
          </div>
          <button
            type="button"
            onClick={() => setImportError(null)}
            className="flex-shrink-0 w-6 h-6 grid place-items-center rounded text-fg-3 hover:text-fg hover:bg-bg-3 transition-colors"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
};

export default App;
