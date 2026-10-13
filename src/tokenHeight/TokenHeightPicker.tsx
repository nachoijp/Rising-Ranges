import { useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import type { GridScale, Image } from "@owlbear-rodeo/sdk";

import { useOBRContext } from "../settings/OBRContext";
import { iconStackPreviewSvg, Direction } from "../render/iconStack";
import { getStoredTheme } from "../theme/themes";
import { getColorString } from "../util/color";
import { getAllTokenHeightMarkers, getTokenHeight, setTokenHeightMarker } from "./markers";
import { clampHeight, heightStepOf, stepHeight } from "../engine/heights";
import { gridUnit } from "../util/flattenGridScale";
import { watchTheme } from "./theme";
import { fixedGround, globalSettingsFromMetadata } from "../settings/globalSettings";
import { terrainAt, terrainZones } from "../terrain/terrain";
import { useTranslation } from "../i18n/useTranslation";
import type { TranslationKey } from "../i18n/translate";

import "./tokenHeight.css";

// This table is plain browser-rendered HTML (unlike the on-map Lectura
// label, which goes through Owlbear's own limited map-text font and can't
// show ↑/↓), so the arrow glyphs are safe to use here.
const DIRECTIONS: { id: Direction; arrow: string }[] = [
  { id: "up", arrow: "↑" },
  { id: "down", arrow: "↓" },
];

const DIRECTION_LABEL_KEYS: Record<Direction, TranslationKey> = {
  up: "tokenHeight.up",
  down: "tokenHeight.down",
};

// A minimum width for the table's equal columns, so it only scrolls
// sideways when there really isn't room.
const ICON_MIN_COLUMN_WIDTH = 44;
const DIRECTION_COL_WIDTH = 20;
const TABLE_BORDER_SPACING = 3;

export function TokenHeightPicker() {
  const { bandSet, display, gridScale } = useOBRContext();
  const t = useTranslation();
  const [selection, setSelection] = useState<string[]>([]);
  /** tokenId -> height above the ground it stands on, for the selected tokens. */
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  /**
   * tokenId -> what's added to show its height: the terrain where it is,
   * when heights are shown above one fixed ground (GlobalSettings.groundLevel); else 0.
   */
  const [below, setBelow] = useState<Map<string, number>>(new Map());

  // Safe here (unlike at module load): this component only mounts once
  // OBRContextProvider above it has already made successful OBR calls of
  // its own, so the SDK's ready handshake is guaranteed to be done.
  useEffect(() => {
    watchTheme();
  }, []);

  useEffect(() => {
    OBR.player.getSelection().then((selection) => setSelection(selection ?? []));
    return OBR.player.onChange((player) => setSelection(player.selection ?? []));
  }, []);

  useEffect(() => {
    if (selection.length === 0) {
      setHeights(new Map());
      return;
    }
    Promise.all([getAllTokenHeightMarkers(), OBR.scene.getMetadata(), OBR.scene.items.getItems()]).then(
      ([markers, metadata, items]) => {
        setHeights(
          new Map(
            selection.map((id) => {
              const marker = markers.find((m) => m.attachedTo === id);
              return [id, (marker && getTokenHeight(marker, bandSet)) || 0];
            })
          )
        );
        const terrain = fixedGround(globalSettingsFromMetadata(metadata)) ? terrainZones(items) : [];
        const positions = new Map(items.map((item) => [item.id, item.position]));
        setBelow(
          new Map(
            selection.map((id) => {
              const position = positions.get(id);
              return [id, position ? terrainAt(terrain, position) : 0];
            })
          )
        );
      }
    );
  }, [selection, bandSet]);

  /** The selection's height as shown, or undefined if the selected tokens differ. */
  const values = selection.map((id) => (heights.get(id) ?? 0) + (below.get(id) ?? 0));
  const current = values.length > 0 && values.every((h) => h === values[0]) ? values[0] : undefined;

  /**
   * Sets each selected token to the height `next` gives it from the one
   * shown, kept above the ground it stands on. The ground (0) is standing
   * on the terrain, wherever heights are shown from.
   */
  async function applyHeights(next: (height: number) => number) {
    if (selection.length === 0) {
      return;
    }
    const tokens = await OBR.scene.items.getItems<Image>(selection);
    const updated = new Map(heights);
    const groups = new Map<number, Image[]>();
    for (const token of tokens) {
      const added = below.get(token.id) ?? 0;
      const target = next((heights.get(token.id) ?? 0) + added);
      const height = clampHeight(target === 0 ? 0 : target - added);
      updated.set(token.id, height);
      groups.set(height, [...(groups.get(height) ?? []), token]);
    }
    for (const [height, group] of groups) {
      await setTokenHeightMarker(group, height);
    }
    setHeights(updated);
  }

  if (selection.length === 0) {
    return (
      <div style={{ fontSize: 13, opacity: 0.7 }}>{t("tokenHeight.selectToken")}</div>
    );
  }

  if (heightStepOf(bandSet) === "unit") {
    return (
      <UnitStepper
        current={current}
        gridScale={gridScale}
        onStep={(direction) => applyHeights((height) => stepHeight(height, direction, bandSet))}
        onSet={(height) => applyHeights(() => height)}
      />
    );
  }

  const theme = getStoredTheme();

  // The closest Banda (e.g. Melee) means "right next to it", which makes no
  // sense as a height, so it's left out. Each Banda keeps its index in
  // bandSet.bands, as markers.ts uses it, so the preview matches the marker.
  const closestBand = bandSet.bands.reduce(
    (min, band) => (band.radius < min.radius ? band : min),
    bandSet.bands[0]
  );
  const markableBands = bandSet.bands
    .map((band, index) => ({ band, index }))
    .filter(({ band }) => band.id !== closestBand?.id);

  const minTableWidth =
    markableBands.length * ICON_MIN_COLUMN_WIDTH +
    DIRECTION_COL_WIDTH +
    (markableBands.length + 2) * TABLE_BORDER_SPACING;

  return (
    <div className="picker-scroll">
      <table className="altitude-table" style={{ minWidth: minTableWidth }}>
        <colgroup>
          <col className="direction-col" />
          {markableBands.map(({ band }) => (
            <col key={band.id} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th></th>
            {markableBands.map(({ band }) => (
              <th key={band.id}>{band.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DIRECTIONS.map((direction) => (
            <tr key={direction.id}>
              <th className="direction-header" title={t(DIRECTION_LABEL_KEYS[direction.id])}>
                {direction.arrow}
              </th>
              {markableBands.map(({ band, index }) => {
                const height = direction.id === "up" ? band.radius : -band.radius;
                const active = current === height;
                const shape = band.iconShape ?? display.iconShape;
                const color = getColorString(theme.colors[index % theme.colors.length]);
                const svg = iconStackPreviewSvg(shape, index + 1, color, direction.id);
                return (
                  <td key={band.id}>
                    <button
                      className={active ? "rank-button active" : "rank-button"}
                      title={`${band.name} · ${t(DIRECTION_LABEL_KEYS[direction.id])}`}
                      // No separate "remove marker" control: clicking the
                      // active cell again puts the token back on the ground.
                      onClick={() => applyHeights(() => (active ? 0 : height))}
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Cell-by-cell heights: one cell down or up, the height itself (typed in
 * the grid's own units, e.g. "35" ft, rounded to whole cells), and back to
 * the ground.
 */
export function UnitStepper({
  current,
  gridScale,
  onStep,
  onSet,
}: {
  /** undefined when the selected tokens are at different heights. */
  current: number | undefined;
  gridScale: GridScale;
  onStep: (direction: 1 | -1) => void;
  onSet: (height: number) => void;
}) {
  const t = useTranslation();
  const multiplier = gridScale.parsed.multiplier || 1;
  const shown = current === undefined ? "" : String(+(current * multiplier).toFixed(gridScale.parsed.digits));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  function commit() {
    const value = Number(draft.replace(",", "."));
    if (draft.trim() === "" || !Number.isFinite(value)) {
      setDraft(shown);
      return;
    }
    const height = clampHeight(Math.round(value / multiplier));
    if (height === current) {
      setDraft(shown);
    } else {
      onSet(height);
    }
  }

  return (
    <div className="step-row">
      <button className="step-button" title={t("tokenHeight.lower")} aria-label={t("tokenHeight.lower")} onClick={() => onStep(-1)}>
        −
      </button>
      <label className="step-field">
        <input
          className="step-input"
          inputMode="decimal"
          value={draft}
          placeholder="—"
          aria-label={t("tokenHeight.height")}
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
        <span className="step-unit">{gridUnit(gridScale).trim()}</span>
      </label>
      <button className="step-button" title={t("tokenHeight.raise")} aria-label={t("tokenHeight.raise")} onClick={() => onStep(1)}>
        +
      </button>
      <button
        className={current === 0 ? "step-button ground active" : "step-button ground"}
        onClick={() => onSet(0)}
      >
        {t("onMap.ground")}
      </button>
    </div>
  );
}
