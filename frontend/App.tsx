import React, { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import ModelList from "./components/ModelList";
import DetailPanel from "./components/DetailPanel";
import Settings from "./components/Settings";
import RecentView from "./components/RecentView";
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
import Snackbar, { SnackbarCloseReason } from "@mui/material/Snackbar";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import Alert from "@mui/material/Alert";

const App = () => {
  const isDesktop = useMediaQuery("(min-width: 1024px)", true);
  const isMobile = !isDesktop;
  const visualViewport = useVisualViewport();
  // Theme follows the data-theme attribute on <html>. Settings updates both
  // this state and the attribute; we mirror the attribute → MUI palette here
  // so MUI's CssBaseline doesn't repaint body with its own defaults.
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
  // MUI palette won't take oklch() — these are sRGB approximations of the
  // tokens in globals.css.
  const muiTheme = createTheme({
    palette:
      theme === "dark"
        ? {
            mode: "dark",
            background: {
              default: "rgb(30, 28, 26)", // oklch(0.155 0.005 60) — warm graphite
              paper: "rgb(46, 43, 40)", // oklch(0.21 0.007 60)
            },
            text: {
              primary: "rgb(244, 240, 232)", // oklch(0.96 0.008 80)
              secondary: "rgb(195, 188, 175)", // oklch(0.78 0.01 70)
            },
          }
        : {
            mode: "light",
            background: {
              default: "rgb(251, 250, 248)", // oklch(0.985 0.003 80)
              paper: "rgb(255, 255, 255)", // oklch(1 0 0)
            },
            text: {
              primary: "rgb(48, 46, 43)", // oklch(0.2 0.01 60)
              secondary: "rgb(108, 105, 100)", // oklch(0.42 0.01 60)
            },
          },
    typography: {
      fontFamily:
        '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif',
    },
  });
  const [folders, setFolders] = useState<Folder[]>([]);
  const [models, setModels] = useState<STLModel[]>([]);
  const [storageStats, setStorageStats] = useState<StorageStats>({
    used: 0,
    total: 0,
  });

  const [currentFolderId, setCurrentFolderId] = useState<string>("all");
  const [currentFolderParentId, setCurrentFolderParentId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<number>(0);
  const location = useLocation();
  const navigate = useNavigate();
  const showSettings = location.pathname === "/settings";
  const showRecent = location.pathname === "/recent";
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
      } catch (error) {
        console.error(`Failed to upload ${file.name}:`, error);
      } finally {
        setUploadQueue((prev) => prev - 1);
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
      // Default to first folder if available
      setUploadFolderId(folders.length > 0 ? folders[0].id : "");
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
    // Pre-select current folder if specific, otherwise first available
    setImportFolderId(
      currentFolderId !== "all" ? currentFolderId : folders[0]?.id || "",
    );
    setShowImportModal(true);
  };

  const handleOpenLiked = () => {
    setBambuAuthExpired(false);
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
          } finally {
            setUploadQueue((prev) => Math.max(0, prev - 1));
          }
        }
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
      alert("Failed to import from URL");
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
        alert("Failed to import from URL");
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
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
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
                <div
                  className={`fixed left-0 top-0 z-[60] bg-black/60 backdrop-blur-sm flex justify-center p-4 ${
                    visualViewport.keyboardOpen ? "items-start" : "items-center"
                  }`}
                  style={{
                    width: "100%",
                    height:
                      visualViewport.height ||
                      (typeof window !== "undefined" ? window.innerHeight : 0),
                    transform: `translate(${visualViewport.offsetLeft}px, ${visualViewport.offsetTop}px)`,
                  }}
                >
                  <div
                    className="bg-surface border border-border rounded-xl p-6 w-96 shadow-2xl animate-in zoom-in-95 duration-200 overflow-y-auto"
                    style={{
                      maxHeight: Math.max(
                        240,
                        (visualViewport.height ||
                          (typeof window !== "undefined"
                            ? window.innerHeight
                            : 0)) - 32,
                      ),
                    }}
                  >
                    <div className="flex justify-between items-center mb-6">
                      <h3 className="text-xl font-bold text-white flex items-center gap-2">
                        <FileUp className="w-5 h-5 text-accent" /> Upload
                        Files
                      </h3>
                      <button
                        onClick={() => setShowUploadModal(false)}
                        className="text-fg-3 hover:text-fg"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    <form onSubmit={handleConfirmUpload}>
                      <div className="mb-4 p-3 bg-bg-2/50 rounded-lg border border-border-soft">
                        <p className="text-sm text-fg-2 font-medium">
                          {pendingFiles.length} files selected
                        </p>
                        <p className="text-xs text-fg-3 truncate mt-1">
                          {pendingFiles.map((f) => f.name).join(", ")}
                        </p>
                      </div>

                      <div className="mb-4">
                        <label className="block text-sm font-medium text-fg-3 mb-1">
                          Destination Folder
                        </label>
                        <select
                          className="w-full bg-bg-2 border border-border rounded-md px-3 py-2 text-white focus:border-accent outline-none"
                          value={uploadFolderId}
                          onChange={(e) => setUploadFolderId(e.target.value)}
                        >
                          <option value="" disabled>
                            Select a folder...
                          </option>
                          {folders.map((folder) => (
                            <option key={folder.id} value={folder.id}>
                              {folder.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="mb-6">
                        <label className="block text-sm font-medium text-fg-3 mb-1">
                          Add Tags (Optional)
                        </label>
                        <input
                          type="text"
                          className="w-full bg-bg-2 border border-border rounded-md px-3 py-2 text-white focus:border-accent outline-none placeholder:text-fg-3"
                          placeholder="scifi, armor, weapon..."
                          value={uploadTags}
                          onChange={(e) => setUploadTags(e.target.value)}
                        />
                        <p className="text-xs text-fg-3 mt-1">
                          Separate tags with commas
                        </p>
                      </div>

                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => setShowUploadModal(false)}
                          className="flex-1 py-2 rounded-lg bg-bg-3 hover:bg-surface-2 text-fg font-medium transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!uploadFolderId}
                          className="flex-1 py-2 rounded-lg bg-accent hover:brightness-105 text-accent-fg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Upload
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              {/* Import URL Modal */}
              {showImportModal && (
                <div
                  className={`fixed left-0 top-0 z-[60] bg-black/60 backdrop-blur-sm flex justify-center p-4 ${
                    visualViewport.keyboardOpen ? "items-start" : "items-center"
                  }`}
                  style={{
                    width: "100%",
                    height:
                      visualViewport.height ||
                      (typeof window !== "undefined" ? window.innerHeight : 0),
                    transform: `translate(${visualViewport.offsetLeft}px, ${visualViewport.offsetTop}px)`,
                  }}
                >
                  <div
                    className="bg-surface border border-border rounded-xl p-6 w-96 shadow-2xl animate-in zoom-in-95 duration-200 overflow-y-auto"
                    style={{
                      maxHeight: Math.max(
                        240,
                        (visualViewport.height ||
                          (typeof window !== "undefined"
                            ? window.innerHeight
                            : 0)) - 32,
                      ),
                    }}
                  >
                    <div className="flex justify-between items-center mb-6">
                      <h3 className="text-xl font-bold text-white flex items-center gap-2">
                        <Globe className="w-5 h-5 text-accent" /> Import
                        from URL
                      </h3>
                      <button
                        onClick={() => setShowImportModal(false)}
                        className="text-fg-3 hover:text-fg"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    <form onSubmit={handleImportSubmit}>
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-fg-3 mb-1">
                          Model URL
                        </label>
                        <input
                          autoFocus
                          type="url"
                          required
                          className="w-full bg-bg-2 border border-border rounded-md px-3 py-2 text-white focus:border-accent outline-none placeholder:text-fg-3"
                          placeholder="https://www.printables.com/model/... or https://makerworld.com/en/models/..."
                          value={importUrl}
                          onChange={(e) => setImportUrl(e.target.value)}
                        />
                        <p className="text-xs text-fg-3 mt-1">
                          Paste a link from Printables or Makerworld. Makerworld
                          downloads require a Bambu Cloud sign-in in Settings.
                        </p>
                      </div>

                      {bambuAuthExpired && (
                        <div className="mb-4 p-3 bg-red-900/30 border border-red-700/50 rounded-lg text-sm text-red-200">
                          <p className="font-semibold mb-1">
                            Bambu Cloud sign-in required
                          </p>
                          <p className="text-red-300/90">
                            Open Settings &rarr; Bambu Cloud and sign in (or
                            re-sign-in) to import from Makerworld.
                          </p>
                        </div>
                      )}

                      <div className="mb-6">
                        <label className="block text-sm font-medium text-fg-3 mb-1">
                          Destination Folder
                        </label>
                        <select
                          className="w-full bg-bg-2 border border-border rounded-md px-3 py-2 text-white focus:border-accent outline-none"
                          value={importFolderId}
                          onChange={(e) => setImportFolderId(e.target.value)}
                        >
                          <option value="" disabled>
                            Select a folder...
                          </option>
                          {folders.map((folder) => (
                            <option key={folder.id} value={folder.id}>
                              {folder.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => setShowImportModal(false)}
                          className="flex-1 py-2 rounded-lg bg-bg-3 hover:bg-surface-2 text-fg font-medium transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!importUrl || !importFolderId}
                          className="flex-1 py-2 rounded-lg bg-accent hover:brightness-105 text-accent-fg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Import
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              {/* Import Options Modal */}
              <MakerworldLikedModal
                open={showLikedModal}
                onClose={() => setShowLikedModal(false)}
                folders={folders}
                defaultFolderId={
                  currentFolderId !== "all"
                    ? currentFolderId
                    : folders[0]?.id || ""
                }
                onImport={handleLikedImport}
                bambuAuthExpired={bambuAuthExpired}
              />

              {showImportOptionsModal && (
                <div
                  className={`fixed left-0 top-0 z-[60] bg-black/60 backdrop-blur-sm flex justify-center p-4 ${
                    visualViewport.keyboardOpen ? "items-start" : "items-center"
                  }`}
                  style={{
                    width: "100%",
                    height:
                      visualViewport.height ||
                      (typeof window !== "undefined" ? window.innerHeight : 0),
                    transform: `translate(${visualViewport.offsetLeft}px, ${visualViewport.offsetTop}px)`,
                  }}
                >
                  <div
                    className="relative bg-surface border border-border rounded-xl p-6 w-full lg:w-1/2 shadow-2xl animate-in zoom-in-95 duration-200 "
                    style={{
                      maxHeight: Math.max(
                        240,
                        (visualViewport.height ||
                          (typeof window !== "undefined"
                            ? window.innerHeight
                            : 0)) - 32,
                      ),
                    }}
                  >
                    <div className="static flex top-0 justify-between items-center mb-6">
                      <h3 className="text-xl font-bold text-white flex items-center gap-2">
                        <Globe className="w-5 h-5 text-accent" /> Select
                        model to download
                      </h3>
                      <button
                        onClick={() => setShowImportOptionsModal(false)}
                        className="text-fg-3 hover:text-fg"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    {/* File List */}
                    <div
                      className={`static overflow-auto px-2 ${
                        visualViewport.height > 900 ? "h-[700px]" : "h-[400px]"
                      }`}
                    >
                      {Array.from(folderOptions).map((f) => (
                        <div>
                          <div className="text-xl font-medium p-4">
                            {f ? f : "Root Folder"}
                          </div>
                          {modelsOptions.map((model) => (
                            <div>
                              {model.folder == f ? (
                                <div
                                  key={model.id}
                                  onClick={() =>
                                    handleOptionsToggleSelection(model.id)
                                  }
                                  className={`group bg-bg-2 border rounded-xl p-4 cursor-pointer transition-all flex items-center gap-4 mb-2 relative overflow-hidden
                              ${
                                selectedOptions.has(model.id)
                                  ? "border-accent ring-1 ring-accent/50"
                                  : "border-border hover:border-border"
                              }
                            `}
                                >
                                  <div className="w-12 h-12 bg-accent/15 rounded-lg flex items-center justify-center text-accent group-hover:text-accent group-hover:scale-110 transition-all shrink-0">
                                    <img
                                      src={model.previewPath}
                                      alt={model.name}
                                      className="w-12 h-12 object-contain opacity-80 group-hover:opacity-100 transition-opacity"
                                    />
                                  </div>

                                  <div className="min-w-0">
                                    <h3 className="font-semibold text-fg truncate group-hover:text-fg">
                                      {model.name}
                                    </h3>
                                    <p className="text-xs text-fg-3">
                                      {model.typeName}
                                    </p>
                                  </div>
                                </div>
                              ) : (
                                <div></div>
                              )}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>

                    <div
                      onClick={() => handleImportChoice()}
                      className="static bottom-0 p-2 mt-4 cursor-pointer rounded-lg bg-bg-3 hover:bg-surface-2 text-fg font-medium transition-colors text-center"
                    >
                      {" "}
                      Import{" "}
                    </div>
                  </div>
                </div>
              )}

              {/* Delete Confirmation Modal */}
              {deleteConfirmState.isOpen && (
                <div
                  className={`fixed left-0 top-0 z-[60] bg-black/60 backdrop-blur-sm flex justify-center p-4 ${
                    visualViewport.keyboardOpen ? "items-start" : "items-center"
                  }`}
                  style={{
                    width: "100%",
                    height:
                      visualViewport.height ||
                      (typeof window !== "undefined" ? window.innerHeight : 0),
                    transform: `translate(${visualViewport.offsetLeft}px, ${visualViewport.offsetTop}px)`,
                  }}
                >
                  <div
                    className="bg-surface border border-border rounded-xl p-6 w-96 shadow-2xl animate-in zoom-in-95 duration-200 overflow-y-auto"
                    style={{
                      maxHeight: Math.max(
                        240,
                        (visualViewport.height ||
                          (typeof window !== "undefined"
                            ? window.innerHeight
                            : 0)) - 32,
                      ),
                    }}
                  >
                    <div className="flex flex-col items-center text-center mb-6">
                      <div className="w-12 h-12 bg-red-900/30 rounded-full flex items-center justify-center mb-4">
                        <AlertTriangle className="w-6 h-6 text-red-500" />
                      </div>
                      <h3 className="text-xl font-bold text-white mb-2">
                        Confirm Deletion
                      </h3>
                      <p className="text-fg-3 text-sm">
                        {deleteConfirmState.type === "single" &&
                          "Are you sure you want to delete this model? This action cannot be undone."}
                        {deleteConfirmState.type === "bulk" &&
                          `Are you sure you want to delete ${selectedIds.size} models? This action cannot be undone.`}
                        {deleteConfirmState.type === "folder" &&
                          "Are you sure you want to delete this folder?"}
                      </p>
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={() =>
                          setDeleteConfirmState((prev) => ({
                            ...prev,
                            isOpen: false,
                          }))
                        }
                        className="flex-1 py-2.5 rounded-lg bg-bg-3 hover:bg-surface-2 text-fg font-medium transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={executeDelete}
                        className="flex-1 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {showMoveModal && (
                <div
                  className={`fixed left-0 top-0 z-50 bg-black/60 backdrop-blur-sm flex justify-center p-4 ${
                    visualViewport.keyboardOpen ? "items-start" : "items-center"
                  }`}
                  style={{
                    width: "100%",
                    height:
                      visualViewport.height ||
                      (typeof window !== "undefined" ? window.innerHeight : 0),
                    transform: `translate(${visualViewport.offsetLeft}px, ${visualViewport.offsetTop}px)`,
                  }}
                >
                  <div
                    className="bg-surface border border-border rounded-xl p-6 w-80 shadow-2xl animate-in zoom-in-95 duration-200 overflow-y-auto"
                    style={{
                      maxHeight: Math.max(
                        200,
                        (visualViewport.height ||
                          (typeof window !== "undefined"
                            ? window.innerHeight
                            : 0)) - 32,
                      ),
                    }}
                  >
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-white flex items-center gap-2">
                        <FolderInput className="w-4 h-4" /> Move to Folder
                      </h3>
                      <button
                        onClick={() => setShowMoveModal(false)}
                        className="text-fg-3 hover:text-fg"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="space-y-2 max-h-64 overflow-y-auto mb-4">
                      {folders.map((folder) => (
                        <button
                          key={folder.id}
                          onClick={() => handleBulkMoveSubmit(folder.id)}
                          className="w-full text-left px-3 py-2 rounded hover:bg-bg-3 text-fg-2 hover:text-fg text-sm transition-colors"
                        >
                          {folder.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {showTagModal && (
                <div
                  className={`fixed left-0 top-0 z-50 bg-black/60 backdrop-blur-sm flex justify-center p-4 ${
                    visualViewport.keyboardOpen ? "items-start" : "items-center"
                  }`}
                  style={{
                    width: "100%",
                    height:
                      visualViewport.height ||
                      (typeof window !== "undefined" ? window.innerHeight : 0),
                    transform: `translate(${visualViewport.offsetLeft}px, ${visualViewport.offsetTop}px)`,
                  }}
                >
                  <div
                    className="bg-surface border border-border rounded-xl p-6 w-96 shadow-2xl animate-in zoom-in-95 duration-200 overflow-y-auto"
                    style={{
                      maxHeight: Math.max(
                        240,
                        (visualViewport.height ||
                          (typeof window !== "undefined"
                            ? window.innerHeight
                            : 0)) - 32,
                      ),
                    }}
                  >
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-white flex items-center gap-2">
                        <Tags className="w-4 h-4" /> Add Tags
                      </h3>
                      <button
                        onClick={() => setShowTagModal(false)}
                        className="text-fg-3 hover:text-fg"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <form onSubmit={handleBulkTagSubmit}>
                      <p className="text-sm text-fg-3 mb-2">
                        Add tags to {selectedIds.size} items (comma separated):
                      </p>
                      <input
                        autoFocus
                        type="text"
                        className="w-full bg-bg-2 border border-border rounded-md px-3 py-2 text-white focus:border-accent outline-none mb-4"
                        placeholder="scifi, armor, weapon..."
                        value={bulkTags}
                        onChange={(e) => setBulkTags(e.target.value)}
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setShowTagModal(false)}
                          className="px-3 py-1.5 text-sm text-fg-2 hover:text-fg"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="px-3 py-1.5 text-sm bg-accent hover:brightness-105 text-accent-fg rounded"
                        >
                          Add Tags
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}
            </main>
          </>
        )}
        <Snackbar
          open={!port ? true : false}
          autoHideDuration={6000}
          message="API Host Not Set"
          anchorOrigin={{ vertical: "top", horizontal: "center" }}
        >
          <Alert severity="error" variant="filled" sx={{ width: "100%" }}>
            API Host Not Set
          </Alert>
        </Snackbar>
      </div>
    </ThemeProvider>
  );
};

export default App;
