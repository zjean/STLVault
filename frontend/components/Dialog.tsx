import React, { useEffect } from "react";
import { X } from "lucide-react";
import { useVisualViewport } from "../hooks/useVisualViewport";

type Size = "sm" | "md";

const SIZE_CLASS: Record<Size, string> = {
  sm: "w-full max-w-[420px]",
  md: "w-full max-w-[640px]",
};

interface DialogProps {
  onClose: () => void;
  title: React.ReactNode;
  icon?: React.ReactNode;
  size?: Size;
  children: React.ReactNode;
  closeOnBackdrop?: boolean;
}

const Dialog: React.FC<DialogProps> = ({
  onClose,
  title,
  icon,
  size = "sm",
  children,
  closeOnBackdrop = true,
}) => {
  const viewport = useVisualViewport();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fallbackHeight =
    typeof window !== "undefined" ? window.innerHeight : 0;
  const overlayHeight = viewport.height || fallbackHeight;
  const panelMaxHeight = Math.max(240, overlayHeight - 32);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={closeOnBackdrop ? onClose : undefined}
      className={`fixed left-0 top-0 z-[60] bg-black/60 backdrop-blur-sm flex justify-center p-4 ${
        viewport.keyboardOpen ? "items-start" : "items-center"
      }`}
      style={{
        width: "100%",
        height: overlayHeight,
        transform: `translate(${viewport.offsetLeft}px, ${viewport.offsetTop}px)`,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${SIZE_CLASS[size]} bg-surface border border-border-soft rounded-card shadow-lifted animate-in zoom-in-95 duration-200 overflow-hidden flex flex-col`}
        style={{ maxHeight: panelMaxHeight }}
      >
        <header className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border-soft">
          {icon && (
            <span className="text-accent inline-flex items-center" aria-hidden>
              {icon}
            </span>
          )}
          <h3 className="text-[15px] font-semibold -tracking-[0.005em] text-fg m-0 flex-1 truncate">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

export default Dialog;
