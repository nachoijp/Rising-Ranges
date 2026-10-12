import { useEffect, useState } from "react";
import OBR, { type Item } from "@owlbear-rodeo/sdk";

import { clampFootprint, FOOTPRINTS, getTokenFootprint, setTokenFootprint } from "./footprint";
import { watchTheme } from "./theme";
import { useTranslation } from "../i18n/useTranslation";

import "./tokenHeight.css";

/** The selection's footprint: a number of cells, "auto" (from the image), or undefined when they differ. */
function sharedFootprint(tokens: Item[]): number | "auto" | undefined {
  const values = tokens.map((token) => getTokenFootprint(token) ?? "auto");
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

/** The context menu's "Footprint": Auto (from the image), 1–4 cells across, or a size typed by hand. */
export function FootprintPicker() {
  const t = useTranslation();
  const [selection, setSelection] = useState<string[]>([]);
  const [current, setCurrent] = useState<number | "auto" | undefined>(undefined);

  useEffect(() => {
    watchTheme();
  }, []);

  useEffect(() => {
    OBR.player.getSelection().then((selection) => setSelection(selection ?? []));
    return OBR.player.onChange((player) => setSelection(player.selection ?? []));
  }, []);

  useEffect(() => {
    if (selection.length === 0) {
      setCurrent(undefined);
      return;
    }
    OBR.scene.items.getItems(selection).then((tokens) => setCurrent(sharedFootprint(tokens)));
  }, [selection]);

  async function apply(value: number | "auto") {
    if (selection.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(selection, (tokens) => {
      for (const token of tokens) {
        setTokenFootprint(token, value === "auto" ? undefined : value);
      }
    });
    setCurrent(value);
  }

  if (selection.length === 0) {
    return <div style={{ fontSize: 13, opacity: 0.7 }}>{t("tokenHeight.selectToken")}</div>;
  }

  return (
    <div role="group" aria-label={t("footprint.label")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="step-row" style={{ height: "auto" }}>
        <button
          className={current === "auto" ? "step-button ground active" : "step-button ground"}
          style={{ marginLeft: 0 }}
          title={t("footprint.autoTooltip")}
          aria-pressed={current === "auto"}
          onClick={() => apply("auto")}
        >
          {t("footprint.auto")}
        </button>
        {FOOTPRINTS.map((cells) => (
          <button
            key={cells}
            className={current === cells ? "step-button active" : "step-button"}
            style={{ flex: 1, fontSize: 14 }}
            title={t("footprint.cells", { cells: String(cells) })}
            aria-label={t("footprint.cells", { cells: String(cells) })}
            aria-pressed={current === cells}
            onClick={() => apply(cells)}
          >
            {cells}×{cells}
          </button>
        ))}
      </div>
      <CustomFootprint current={current} onSet={apply} />
    </div>
  );
}

/** "Custom: [2.5] squares" — any size, for what the presets don't cover. */
function CustomFootprint({ current, onSet }: { current: number | "auto" | undefined; onSet: (cells: number) => void }) {
  const t = useTranslation();
  const shown = typeof current === "number" ? String(current) : "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  function commit() {
    const value = Number(draft.replace(",", "."));
    if (draft.trim() === "" || !Number.isFinite(value) || value <= 0) {
      setDraft(shown);
      return;
    }
    const cells = clampFootprint(value);
    if (cells === current) {
      setDraft(shown);
    } else {
      onSet(cells);
    }
  }

  // Outlined like an active preset when the size is one only this field gives.
  const custom = typeof current === "number" && !(FOOTPRINTS as readonly number[]).includes(current);
  return (
    <label className={custom ? "step-field active" : "step-field"} style={{ flex: "none" }}>
      <span className="step-unit">{t("footprint.custom")}</span>
      <input
        className="step-input"
        inputMode="decimal"
        value={draft}
        placeholder="—"
        aria-label={t("footprint.custom")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          } else if (event.key === "Escape") {
            setDraft(shown);
          }
        }}
      />
      <span className="step-unit">{t("footprint.customUnit")}</span>
    </label>
  );
}
