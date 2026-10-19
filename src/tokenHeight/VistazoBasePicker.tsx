import { useEffect, useRef, useState } from "react";
import OBR, { isImage, type Image, type Item } from "@owlbear-rodeo/sdk";

import { getVistazoBase, setVistazoBase, type VistazoBase } from "./footprint";
import { visibleBox, type VisibleBox } from "../vistazo/visibleBox";
import { useTranslation } from "../i18n/useTranslation";

import "./tokenHeight.css";

/** The thumbnail's side, px (createTokenHeightMenu sizes the menu to it). */
export const BASE_THUMB_SIZE = 96;

/** The selection's base: set by hand alike, "auto" for all from their image, undefined when they differ. */
function sharedBase(items: Item[]): VistazoBase | "auto" | undefined {
  const values = items.map((item) => getVistazoBase(item) ?? "auto");
  const first = values[0];
  if (values.length === 0) {
    return undefined;
  }
  const same = values.every((value) => (value === "auto" || first === "auto" ? value === first : value.x === first.x && value.y === first.y));
  return same ? first : undefined;
}

/**
 * The Vistazo 3D's "Base": where a standing image touches the ground. Its
 * picture (the first selected's) with a cross on that point: a click or a
 * drag on it sets it by hand, Auto goes back to what of the picture shows
 * (see visibleBox, shown greyed). Only for the Vistazo: the map and the
 * distances don't change.
 */
export function VistazoBasePicker() {
  const t = useTranslation();
  const [selection, setSelection] = useState<string[]>([]);
  const [image, setImage] = useState<Image | null>(null);
  const [base, setBase] = useState<VistazoBase | "auto" | undefined>(undefined);
  const [measured, setMeasured] = useState<VisibleBox | null | undefined>(undefined);
  /** Where the cross is while it's dragged (saved on release). */
  const [dragged, setDragged] = useState<VistazoBase | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    OBR.player.getSelection().then((selection) => setSelection(selection ?? []));
    return OBR.player.onChange((player) => setSelection(player.selection ?? []));
  }, []);

  useEffect(() => {
    if (selection.length === 0) {
      setBase(undefined);
      setImage(null);
      return;
    }
    // The selection's items now, and as they change (another client, or the other menu, setting the base);
    // a reply for a selection that's no longer this one is let go.
    let current = true;
    const show = (items: Item[]) => {
      const selected = items.filter((item) => selection.includes(item.id));
      setBase(sharedBase(selected));
      setImage(selected.find(isImage) ?? null);
    };
    OBR.scene.items.getItems(selection).then((items) => current && show(items));
    const unsubscribe = OBR.scene.items.onChange((items) => current && show(items));
    return () => {
      current = false;
      unsubscribe();
    };
  }, [selection]);

  // Measured again only when the picture itself changes (not on every change of its item).
  const imageUrl = image?.image.url;
  const imageVideo = image?.image.mime.startsWith("video") ?? false;
  useEffect(() => {
    if (!imageUrl) {
      setMeasured(undefined);
      return;
    }
    // An image still loading reports later: not once another one is shown.
    let current = true;
    const read = () => {
      if (current) {
        setMeasured(visibleBox(imageUrl, imageVideo, read));
      }
    };
    read();
    return () => {
      current = false;
    };
  }, [imageUrl, imageVideo]);

  async function apply(next: VistazoBase | undefined) {
    if (selection.length === 0) {
      return;
    }
    setBase(next ?? "auto");
    await OBR.scene.items.updateItems(selection, (items) => {
      for (const item of items) {
        setVistazoBase(item, next);
      }
    });
  }

  if (selection.length === 0 || !image) {
    return null;
  }

  // The picture fitted in the square (contain), as fractions of the square.
  const aspect = image.image.width / image.image.height || 1;
  const fit = aspect >= 1 ? { w: 1, h: 1 / aspect } : { w: aspect, h: 1 };
  const inset = { x: (1 - fit.w) / 2, y: (1 - fit.h) / 2 };
  /** A pointer on the square, as a point of the picture (kept on it). */
  const pointAt = (event: React.PointerEvent): VistazoBase => {
    const rect = frame.current!.getBoundingClientRect();
    const fx = ((event.clientX - rect.left) / rect.width - inset.x) / fit.w;
    const fy = ((event.clientY - rect.top) / rect.height - inset.y) / fit.h;
    const round = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    return { x: round(fx), y: round(fy) };
  };

  const auto = base === "auto";
  const shown: VistazoBase | null = dragged ?? (base && base !== "auto" ? base : measured ? { x: measured.base, y: measured.y1 } : auto ? { x: 0.5, y: 1 } : null);
  const isVideo = image.image.mime.startsWith("video");
  return (
    <div className="base-picker" role="group" aria-label={t("footprint.baseSection")}>
      <div
        ref={frame}
        className="base-thumb"
        style={{ width: BASE_THUMB_SIZE, height: BASE_THUMB_SIZE }}
        title={t("footprint.baseHint")}
        // With the keyboard too: the arrows move the cross (a little; with Shift, more).
        tabIndex={0}
        role="slider"
        aria-label={t("footprint.baseHint")}
        aria-valuetext={shown ? `${Math.round(shown.x * 100)}%, ${Math.round((1 - shown.y) * 100)}%` : undefined}
        onKeyDown={(event) => {
          const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
          const step = steps[event.key];
          if (!step || !shown) {
            return;
          }
          event.preventDefault();
          const by = event.shiftKey ? 0.1 : 0.02;
          const round = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
          void apply({ x: round(shown.x + step[0] * by), y: round(shown.y + step[1] * by) });
        }}
        // The browser's own drag of the picture would take the pointer away from the cross.
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragged(pointAt(event));
        }}
        onPointerMove={(event) => {
          if (dragged) {
            setDragged(pointAt(event));
          }
        }}
        onPointerUp={(event) => {
          if (dragged) {
            const point = pointAt(event);
            setDragged(null);
            void apply(point);
          }
        }}
        onPointerCancel={() => setDragged(null)}
      >
        {isVideo ? (
          <video src={image.image.url} muted autoPlay loop playsInline draggable={false} />
        ) : (
          <img src={image.image.url} alt="" draggable={false} />
        )}
        {shown && (
          <span
            className={auto && !dragged ? "base-cross auto" : "base-cross"}
            style={{ left: `${(inset.x + shown.x * fit.w) * 100}%`, top: `${(inset.y + shown.y * fit.h) * 100}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="base-side">
        <button
          className={auto ? "step-button ground active" : "step-button ground"}
          title={t("footprint.baseAutoTooltip")}
          aria-pressed={auto}
          onClick={() => apply(undefined)}
        >
          {t("footprint.auto")}
        </button>
        <span className="base-hint">{t("footprint.baseHint")}</span>
      </div>
    </div>
  );
}
