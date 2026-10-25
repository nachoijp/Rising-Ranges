import Box from "@mui/material/Box";
import { useRef } from "react";

import { icon } from "../relief/editor/icons";
import { useTranslation } from "../i18n/useTranslation";

export type PanelSize = { width: number; height: number };

/**
 * The corner handle that resizes the panel, as the Vistazo's (its .resize in
 * vistazo.css): three short strokes in the bottom-right corner, over the glass
 * frame. Dragged, it sets the panel's size (`onResize` as it goes, `onDone`
 * when let go); double-clicked, the panel fits its content again (`onReset`).
 */
export function ResizeHandle({
  min,
  onResize,
  onDone,
  onReset,
}: {
  min: PanelSize;
  onResize: (size: PanelSize) => void;
  onDone: (size: PanelSize) => void;
  onReset: () => void;
}) {
  const t = useTranslation();
  const start = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const last = useRef<PanelSize | null>(null);
  const frame = useRef(0);
  const sizeAt = (event: React.PointerEvent) => {
    const from = start.current!;
    return {
      width: Math.max(min.width, Math.round(from.width + event.screenX - from.x)),
      height: Math.max(min.height, Math.round(from.height + event.screenY - from.y)),
    };
  };
  return (
    <Box
      role="button"
      aria-label={t("distances.resize")}
      title={t("distances.resize")}
      // Fixed to the page's corner (the popover's), past the inner panel's clipping.
      sx={{
        position: "fixed",
        right: 0,
        bottom: 0,
        width: 20,
        height: 20,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        p: "4px",
        color: "text.secondary",
        opacity: 0.7,
        cursor: "nwse-resize",
        touchAction: "none",
        zIndex: 1,
        "& svg": { width: 11, height: 11 },
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.screenX, y: event.screenY, width: window.innerWidth, height: window.innerHeight };
      }}
      onPointerMove={(event) => {
        if (!start.current) {
          return;
        }
        const size = sizeAt(event);
        last.current = size;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => onResize(size));
      }}
      onPointerUp={() => {
        start.current = null;
        if (last.current) {
          onDone(last.current);
          last.current = null;
        }
      }}
      onPointerCancel={() => {
        start.current = null;
        last.current = null;
      }}
      onDoubleClick={onReset}
    >
      {/* The icon file's, as the Vistazo's (the editor's icons). */}
      <span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: icon("resize") }} />
    </Box>
  );
}

