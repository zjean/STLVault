import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuDivider {
  divider: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuDivider;

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

const MENU_WIDTH = 200;
const VIEWPORT_PAD = 8;

const ContextMenu: React.FC<Props> = ({ x, y, items, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, ready: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width + VIEWPORT_PAD > vw) nx = vw - rect.width - VIEWPORT_PAD;
    if (ny + rect.height + VIEWPORT_PAD > vh)
      ny = vh - rect.height - VIEWPORT_PAD;
    if (nx < VIEWPORT_PAD) nx = VIEWPORT_PAD;
    if (ny < VIEWPORT_PAD) ny = VIEWPORT_PAD;
    setPos({ x: nx, y: ny, ready: true });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[80] min-w-[200px] bg-surface border border-border rounded-[10px] shadow-drawer p-1 flex flex-col gap-0.5"
      style={{
        left: pos.x,
        top: pos.y,
        width: MENU_WIDTH,
        opacity: pos.ready ? 1 : 0,
      }}
    >
      {items.map((entry, i) => {
        if ("divider" in entry) {
          return (
            <hr
              key={`d-${i}`}
              className="border-0 border-t border-border-soft my-1"
            />
          );
        }
        const danger = entry.danger;
        return (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect();
              onClose();
            }}
            className={`text-left px-3 py-2 rounded-md text-[13px] flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed ${
              danger
                ? "text-danger hover:bg-danger/15"
                : "text-fg hover:bg-bg-3"
            }`}
          >
            {entry.icon && (
              <span className="inline-flex items-center" aria-hidden>
                {entry.icon}
              </span>
            )}
            <span className="flex-1">{entry.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
};

export default ContextMenu;
