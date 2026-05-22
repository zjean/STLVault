import React, { useState } from "react";
import { Menu as MenuIcon, ChevronLeft, Check, Moon, Sun } from "lucide-react";
import CloudSettings from "./custom-bambu/CloudSettings";
import SpoolmanSettings from "./custom-spoolman/SpoolmanSettings";

type ThemeMode = "dark" | "light";

interface SettingsProps {
  onBack: () => void;
  onOpenMobileSidebar?: () => void;
  theme: ThemeMode;
  onThemeChange: (next: ThemeMode) => void;
}

type SlicerType = "orcaslicer" | "prusaslicer" | "bambu" | "cura";

interface SlicerConfig {
  name: string;
  protocol: string;
}

const SLICERS: Record<SlicerType, SlicerConfig> = {
  orcaslicer: { name: "OrcaSlicer", protocol: "orcaslicer://open?file=" },
  prusaslicer: { name: "PrusaSlicer", protocol: "prusaslicer://open?file=" },
  bambu: { name: "Bambu Studio", protocol: "bambustudio://open?file=" },
  cura: { name: "Cura", protocol: "cura://open?file=" },
};

const Settings: React.FC<SettingsProps> = ({
  onBack,
  onOpenMobileSidebar,
  theme,
  onThemeChange,
}) => {
  const [apiPortStatus, setApiPortStatus] = useState(
    !!localStorage.getItem("api-port-override"),
  );
  const [selectedSlicer, setSelectedSlicer] = useState<SlicerType>(() => {
    const saved = localStorage.getItem("stlvault-slicer");
    return saved && saved in SLICERS ? (saved as SlicerType) : "orcaslicer";
  });

  const [selectedApiPort, setSelectedApiPort] = useState<string>(() => {
    return (
      localStorage.getItem("api-port-override") ||
      import.meta.env.VITE_API_URL ||
      ""
    );
  });

  const handleSlicerChange = (slicer: SlicerType) => {
    setSelectedSlicer(slicer);
    localStorage.setItem("stlvault-slicer", slicer);
  };

  const handleApiPortChange = (port: string) => {
    setSelectedApiPort(port);
    setApiPortStatus(false);
  };

  const handleApiForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedApiPort) return;
    localStorage.setItem("api-port-override", selectedApiPort);
    setApiPortStatus(true);
  };

  const handleClearApiPort = () => {
    localStorage.removeItem("api-port-override");
    setSelectedApiPort(import.meta.env.VITE_API_URL || "");
    setApiPortStatus(false);
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-bg">
      {/* Header */}
      <header className="px-4 py-3.5 md:px-7 md:py-4 border-b border-border-soft flex items-center gap-3">
        {onOpenMobileSidebar && (
          <button
            type="button"
            onClick={onOpenMobileSidebar}
            className="md:hidden w-9 h-9 grid place-items-center rounded-md text-fg hover:bg-bg-3 transition-colors"
            aria-label="Open sidebar"
          >
            <MenuIcon size={20} />
          </button>
        )}
        <button
          type="button"
          onClick={onBack}
          className="hidden md:inline-flex items-center gap-1.5 px-2 py-1.5 -ml-1 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors text-[13px]"
        >
          <ChevronLeft size={16} />
          Library
        </button>
        <h1 className="text-[16px] md:text-[22px] font-semibold -tracking-[0.02em] text-fg">
          Settings
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-4 md:px-7 py-7">
          {/* Lead */}
          <div className="mb-8 pb-6 border-b border-border-soft">
            <h2 className="text-[28px] font-semibold -tracking-[0.02em] text-fg m-0">
              Preferences
            </h2>
            <p className="text-fg-3 text-[13.5px] mt-1.5 max-w-[480px]">
              Configure your STL Vault — slicer choice, backend host, and Bambu
              Cloud sign-in.
            </p>
          </div>

          {/* === Appearance === */}
          <section className="mb-9">
            <h3 className="m-0 mb-1 text-[15px] font-semibold -tracking-[0.005em] text-fg">
              Appearance
            </h3>
            <p className="m-0 mb-4 text-[13px] text-fg-3">
              Dark by default — pick the surface tone you'd rather stare at.
            </p>

            <div className="inline-flex bg-bg-3 rounded-lg p-[3px] gap-0.5">
              {(["dark", "light"] as ThemeMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onThemeChange(mode)}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] transition-all ${
                    theme === mode
                      ? "bg-surface text-fg shadow-soft"
                      : "text-fg-3 hover:text-fg"
                  }`}
                  aria-pressed={theme === mode}
                >
                  {mode === "dark" ? <Moon size={14} /> : <Sun size={14} />}
                  <span className="capitalize">{mode}</span>
                </button>
              ))}
            </div>
          </section>

          {/* === Default Slicer === */}
          <section className="mb-9">
            <h3 className="m-0 mb-1 text-[15px] font-semibold -tracking-[0.005em] text-fg">
              Default slicer
            </h3>
            <p className="m-0 mb-4 text-[13px] text-fg-3">
              The app that opens when you click <em>Open in slicer</em> on a
              model. The slicer must register the protocol handler on your OS.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(Object.keys(SLICERS) as SlicerType[]).map((slicer) => {
                const isSelected = selectedSlicer === slicer;
                return (
                  <button
                    key={slicer}
                    type="button"
                    onClick={() => handleSlicerChange(slicer)}
                    className={`relative p-4 rounded-[10px] border-[1.5px] transition-all flex flex-col gap-2 text-left ${
                      isSelected
                        ? "border-accent bg-accent/5"
                        : "border-border-soft bg-surface hover:border-border"
                    }`}
                  >
                    <span className="font-medium text-[14px] text-fg pr-7">
                      {SLICERS[slicer].name}
                    </span>
                    <span className="font-mono text-[11px] text-fg-3 truncate">
                      {SLICERS[slicer].protocol}
                    </span>
                    <span
                      className={`absolute top-3 right-3 w-[18px] h-[18px] rounded-full grid place-items-center border-[1.5px] transition-colors ${
                        isSelected
                          ? "border-accent bg-accent text-accent-fg"
                          : "border-border bg-transparent text-transparent"
                      }`}
                      aria-hidden
                    >
                      <Check size={11} />
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 px-3.5 py-2.5 bg-bg-3 border border-border-soft border-l-[3px] border-l-accent rounded-lg text-[12.5px] text-fg-2">
              <strong className="text-fg font-semibold">Note:</strong> protocol
              setup varies per slicer and OS. If clicking <em>Open in slicer</em>{" "}
              opens nothing, install the slicer first or check its
              "register-protocol" setting.
            </div>
          </section>

          {/* === API Host === */}
          <section className="mb-9">
            <h3 className="m-0 mb-1 text-[15px] font-semibold -tracking-[0.005em] text-fg">
              API host
            </h3>
            <p className="m-0 mb-4 text-[13px] text-fg-3">
              Overrides the backend URL baked into the build. Useful when
              pointing the local frontend at a remote backend.
            </p>

            <div className="px-3.5 py-2.5 mb-4 bg-bg-3 border border-border-soft border-l-[3px] border-l-accent rounded-lg text-[12.5px] text-fg-2">
              <strong className="text-fg font-semibold">Note:</strong> in{" "}
              <code className="font-mono text-[11.5px] bg-bg-2 px-1 py-0.5 rounded">
                npm run dev
              </code>{" "}
              the Vite proxy handles <code className="font-mono text-[11.5px] bg-bg-2 px-1 py-0.5 rounded">/api</code>{" "}
              for you — only set an override here if you really want to talk to
              a non-local backend.
            </div>

            <form
              onSubmit={handleApiForm}
              className="flex flex-col gap-2 max-w-[480px]"
            >
              <label
                htmlFor="api-url-input"
                className="text-[12.5px] font-medium text-fg-2"
              >
                API URL
              </label>
              <input
                id="api-url-input"
                type="url"
                inputMode="url"
                required
                value={selectedApiPort}
                onChange={(e) => handleApiPortChange(e.target.value)}
                placeholder="http://localhost:8000"
                className="font-mono px-3 py-2.5 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all"
              />
              <p className="text-[12px] text-fg-3">
                Where the FastAPI backend is reachable from the browser.
              </p>

              <div className="flex items-center gap-2 mt-1">
                <button
                  type="submit"
                  disabled={!selectedApiPort}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save override
                </button>
                {apiPortStatus && (
                  <button
                    type="button"
                    onClick={handleClearApiPort}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] text-fg-2 transition-colors"
                  >
                    Clear override
                  </button>
                )}
                {apiPortStatus && (
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-success font-medium ml-1">
                    <Check size={13} /> Active
                  </span>
                )}
              </div>
            </form>
          </section>

          {/* === Bambu Cloud (fork addition) === */}
          <section className="mb-9">
            <h3 className="m-0 mb-1 text-[15px] font-semibold -tracking-[0.005em] text-fg">
              Bambu Cloud
            </h3>
            <p className="m-0 mb-4 text-[13px] text-fg-3">
              Sign in to import liked Makerworld designs straight into your
              library.
            </p>
            <div className="rounded-[10px] border border-border-soft bg-surface p-4">
              <CloudSettings />
            </div>
          </section>

          {/* === Spoolman (fork addition) === */}
          <section>
            <h3 className="m-0 mb-1 text-[15px] font-semibold -tracking-[0.005em] text-fg">
              Spoolman
            </h3>
            <p className="m-0 mb-4 text-[13px] text-fg-3">
              Point at your{" "}
              <a
                href="https://github.com/Donkie/Spoolman"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Spoolman
              </a>{" "}
              instance to log prints against real spools and deduct filament
              automatically.
            </p>
            <div className="rounded-[10px] border border-border-soft bg-surface p-4">
              <SpoolmanSettings />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default Settings;
