import { useEffect, useState } from "react";
import OBR, { type Item } from "@owlbear-rodeo/sdk";

import { clampFootprint, clampTall, FOOTPRINTS, getTokenFootprint, getTokenTall, setTokenFootprint, setTokenTall } from "./footprint";
import { watchTheme } from "./theme";
import { useTranslation } from "../i18n/useTranslation";

import "./tokenHeight.css";

type Cells = number | "auto" | undefined;

/** The selection's value: a number of cells, "auto" (from the image), or undefined when they differ. */
function shared(tokens: Item[], read: (token: Item) => number | undefined): Cells {
  const values = tokens.map((token) => read(token) ?? "auto");
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

/**
 * The context menu's "Footprint": Auto (from the image), 1–4 cells across,
 * or a size typed by hand; and how tall the token is, Auto (its image's top)
 * or typed by hand (see setTokenTall).
 */
export function FootprintPicker({
  part,
}: {
  /** Only one of its parts, as a section of the Elevation entry (which already says to select a token). */
  part?: "footprint" | "tall";
} = {}) {
  const t = useTranslation();
  const [selection, setSelection] = useState<string[]>([]);
  const [current, setCurrent] = useState<Cells>(undefined);
  const [tall, setTall] = useState<Cells>(undefined);

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
      setTall(undefined);
      return;
    }
    OBR.scene.items.getItems(selection).then((tokens) => {
      setCurrent(shared(tokens, getTokenFootprint));
      setTall(shared(tokens, getTokenTall));
    });
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

  async function applyTall(value: number | "auto") {
    if (selection.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(selection, (tokens) => {
      for (const token of tokens) {
        setTokenTall(token, value === "auto" ? undefined : value);
      }
    });
    setTall(value);
  }

  if (selection.length === 0) {
    if (part) {
      return null;
    }
    return <div style={{ fontSize: 13, opacity: 0.7 }}>{t("tokenHeight.selectToken")}</div>;
  }

  return (
    <div role="group" aria-label={t("footprint.label")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {part !== "tall" && (
        <>
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
          <CellsField
            label={t("footprint.custom")}
            current={current}
            clamp={clampFootprint}
            active={typeof current === "number" && !(FOOTPRINTS as readonly number[]).includes(current)}
            onSet={apply}
          />
        </>
      )}
      {part !== "footprint" && (
        <div className="step-row" style={{ height: "auto" }}>
          <button
            className={tall === "auto" ? "step-button ground active" : "step-button ground"}
            style={{ marginLeft: 0 }}
            title={t("footprint.tallAutoTooltip")}
            aria-pressed={tall === "auto"}
            onClick={() => applyTall("auto")}
          >
            {t("footprint.auto")}
          </button>
          <CellsField
            label={t("footprint.tall")}
            current={tall}
            clamp={clampTall}
            active={typeof tall === "number"}
            onSet={applyTall}
            grow
          />
        </div>
      )}
    </div>
  );
}

/** "Custom: [2.5] squares" — a number of cells typed by hand, for what the buttons don't cover. */
function CellsField({
  label,
  current,
  clamp,
  active,
  onSet,
  grow,
}: {
  label: string;
  current: Cells;
  clamp: (cells: number) => number;
  /** Outlined like an active button: the value is one only this field gives. */
  active: boolean;
  onSet: (cells: number) => void;
  /** Sharing its row with a button. */
  grow?: boolean;
}) {
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
    const cells = clamp(value);
    if (cells === current) {
      setDraft(shown);
    } else {
      onSet(cells);
    }
  }

  return (
    <label className={active ? "step-field active" : "step-field"} style={{ flex: grow ? 1 : "none" }}>
      <span className="step-unit">{label}</span>
      <input
        className="step-input"
        inputMode="decimal"
        value={draft}
        placeholder="—"
        aria-label={label}
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
