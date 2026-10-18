import { useEffect, useState } from "react";
import OBR, { type Item } from "@owlbear-rodeo/sdk";

import { useOBRContext } from "../settings/OBRContext";
import { clampHeight } from "../engine/heights";
import {
  canBeTerrain,
  getTerrainHeight,
  getTerrainRamp,
  getTerrainCloth,
  getTerrainSkin,
  getTerrainStand,
  getTerrainUnder,
  getTerrainWall,
  getTerrainWater,
  setTerrainHeight,
  setTerrainCloth,
  setTerrainSkin,
  setTerrainUnder,
  setTerrainWater,
  setTerrainRamp,
  setTerrainStand,
  setTerrainWall,
  type TerrainRamp,
  type TerrainStandEdge,
  type TerrainWallStyle,
} from "../terrain/terrain";
import { UnitStepper } from "./TokenHeightPicker";
import { watchTheme } from "./theme";
import { useTranslation } from "../i18n/useTranslation";

import "./tokenHeight.css";

/** Flat, or a ramp rising toward one of its sides: its short name, and what it does (the tooltip). */
const RAMP_CHOICES = [
  ["", "terrain.rampNameNone", "terrain.rampNone"],
  ["up", "terrain.rampNameUp", "terrain.rampUp"],
  ["down", "terrain.rampNameDown", "terrain.rampDown"],
  ["left", "terrain.rampNameLeft", "terrain.rampLeft"],
  ["right", "terrain.rampNameRight", "terrain.rampRight"],
] as const;

/** Lying flat, or standing on an edge: its short name, and what it does (the tooltip). */
const STAND_CHOICES = [
  ["", "terrain.standNameNone", "terrain.standNone"],
  ["auto", "terrain.standNameAuto", "terrain.standAuto"],
  ["bottom", "terrain.standNameBottom", "terrain.standBottom"],
  ["top", "terrain.standNameTop", "terrain.standTop"],
  ["left", "terrain.standNameLeft", "terrain.standLeft"],
  ["right", "terrain.standNameRight", "terrain.standRight"],
] as const;

/** A zone's wall styles in the Vistazo 3D ("": the Vistazo's own), by short names. */
const WALL_CHOICES = [
  ["", "terrain.wallsAuto"],
  ["flat", "terrain.wallFlat"],
  ["stretch", "terrain.wallStretch"],
  ["fold", "terrain.wallFold"],
  // "stone" is brick (see WallStyle in vistazo/render.ts).
  ["stone", "terrain.wallBrick"],
  ["rubble", "terrain.wallRubble"],
  ["earth", "terrain.wallEarth"],
  ["wood", "terrain.wallWood"],
] as const;

/** The selected zones' water depth: a number (0: none), or undefined when they differ or none is terrain. */
function sharedWater(shapes: Item[]): number | undefined {
  const values = shapes.filter((shape) => getTerrainHeight(shape) !== undefined).map((shape) => getTerrainWater(shape) ?? 0);
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

/** The selected zones' underside: a number (0: solid), or undefined when they differ or none is terrain. */
function sharedUnder(shapes: Item[]): number | undefined {
  const values = shapes.filter((shape) => getTerrainHeight(shape) !== undefined).map((shape) => getTerrainUnder(shape) ?? 0);
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

/** The selected shapes' ground height: a number, or undefined when they differ or none is terrain. */
function sharedHeight(shapes: Item[]): number | undefined {
  const values = shapes.map(getTerrainHeight);
  return values.length > 0 && values.every((value) => value !== undefined && value === values[0]) ? values[0] : undefined;
}

/** A shape's context menu "Terrain height": how high the ground is inside it, cell by cell, or not terrain at all. */
export function TerrainPicker() {
  const { gridScale } = useOBRContext();
  const t = useTranslation();
  const [selection, setSelection] = useState<string[]>([]);
  const [shapes, setShapes] = useState<Item[]>([]);

  useEffect(() => {
    watchTheme();
  }, []);

  useEffect(() => {
    OBR.player.getSelection().then((selection) => setSelection(selection ?? []));
    return OBR.player.onChange((player) => setSelection(player.selection ?? []));
  }, []);

  useEffect(() => {
    if (selection.length === 0) {
      setShapes([]);
      return;
    }
    OBR.scene.items.getItems(selection).then((items) => setShapes(items.filter(canBeTerrain)));
  }, [selection]);

  /** Sets each selected shape to the height `next` gives it from its own (0 if it wasn't terrain). */
  async function apply(next: ((height: number) => number) | undefined) {
    const ids = shapes.map((shape) => shape.id);
    if (ids.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        setTerrainHeight(draft, next && clampHeight(next(getTerrainHeight(draft) ?? 0)));
        // Given a height, it's no cloth any more.
        if (next) {
          setTerrainCloth(draft, false);
        }
        // Lowered under its clear space, a bridge keeps a slab: its underside comes down with it.
        const top = getTerrainHeight(draft);
        const under = getTerrainUnder(draft);
        if (top !== undefined && under !== undefined && under >= top) {
          setTerrainUnder(draft, top - 0.05);
        }
        if (!next) {
          setTerrainStand(draft, undefined);
          setTerrainWall(draft, undefined);
          setTerrainRamp(draft, undefined);
          setTerrainUnder(draft, undefined);
          setTerrainSkin(draft, undefined);
          setTerrainWater(draft, undefined);
        }
      }
    });
    setShapes(await OBR.scene.items.getItems(ids));
  }

  /** The selected zones' underside (a bridge or balcony; below 0 for one level with the ground), from each one's own (0: solid). */
  /** Makes the selected shapes cloths (no height of their own: stretched between the terrain round them), or not. */
  async function setCloth(on: boolean) {
    const ids = shapes.map((shape) => shape.id);
    if (ids.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        setTerrainCloth(draft, on);
        if (on) {
          setTerrainHeight(draft, undefined);
          setTerrainRamp(draft, undefined);
          setTerrainStand(draft, undefined);
          setTerrainUnder(draft, undefined);
        }
      }
    });
    setShapes(await OBR.scene.items.getItems(ids));
  }

  /** The water over the selected zones, from each one's own depth (0: none). */
  async function applyWater(next: (cells: number) => number) {
    const ids = shapes.filter((shape) => getTerrainHeight(shape) !== undefined).map((shape) => shape.id);
    if (ids.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        setTerrainWater(draft, Math.max(0, clampHeight(next(getTerrainWater(draft) ?? 0))));
      }
    });
    setShapes(await OBR.scene.items.getItems(selection));
  }

  async function applyUnder(next: (cells: number) => number) {
    const ids = shapes.filter((shape) => getTerrainHeight(shape) !== undefined).map((shape) => shape.id);
    if (ids.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        // Always under its top: a slab at least a twentieth of a cell thick (more would make it no bridge at all).
        const top = getTerrainHeight(draft) ?? 0;
        setTerrainUnder(draft, Math.min(top - 0.05, clampHeight(next(getTerrainUnder(draft) ?? 0))));
      }
    });
    setShapes(await OBR.scene.items.getItems(selection));
  }

  /** Makes the selected zones ramps rising toward `ramp`, or flat again (undefined). */
  async function setRamps(ramp: TerrainRamp | undefined) {
    const ids = shapes.filter((shape) => getTerrainHeight(shape) !== undefined).map((shape) => shape.id);
    if (ids.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        setTerrainRamp(draft, ramp);
      }
    });
    setShapes(await OBR.scene.items.getItems(selection));
  }

  /** The selected zones' walls in the Vistazo 3D: a style of their own, or the Vistazo's (undefined). */
  async function setWalls(style: TerrainWallStyle | undefined) {
    const ids = shapes.filter((shape) => getTerrainHeight(shape) !== undefined).map((shape) => shape.id);
    if (ids.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        setTerrainWall(draft, style);
      }
    });
    setShapes(await OBR.scene.items.getItems(selection));
  }

  /** Stands the selected zones up in the Vistazo 3D on `stand`'s edge, or lays them flat again (all alike). */
  async function toggleStand(stand: TerrainStandEdge | undefined) {
    const ids = shapes.filter((shape) => getTerrainHeight(shape) !== undefined).map((shape) => shape.id);
    if (ids.length === 0) {
      return;
    }
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        setTerrainStand(draft, stand);
      }
    });
    setShapes(await OBR.scene.items.getItems(selection));
  }

  if (shapes.length === 0) {
    return <div style={{ fontSize: 13, opacity: 0.7 }}>{t("terrain.selectShape")}</div>;
  }

  const anyTerrain = shapes.some((shape) => getTerrainHeight(shape) !== undefined);
  const terrainShapes = shapes.filter((shape) => getTerrainHeight(shape) !== undefined);
  const standing = terrainShapes.length > 0 && terrainShapes.every((shape) => getTerrainStand(shape) !== undefined);
  // The edge they all stand on, if it's the same.
  const edges = new Set(terrainShapes.map((shape) => getTerrainStand(shape)));
  const edge = standing && edges.size === 1 ? [...edges][0] : undefined;
  // Their wall style, if they share one ("" for the Vistazo's own, "mixed" when they differ: none lit).
  const wallStyles = new Set(terrainShapes.map((shape) => getTerrainWall(shape) ?? ""));
  const wall = wallStyles.size === 1 ? [...wallStyles][0] : "mixed";
  // How they stand, if alike: flat ("") or the edge; -1 when they differ.
  const standValue = standing ? edge : edges.size === 1 ? "" : undefined;
  const standIndex = STAND_CHOICES.findIndex(([value]) => value === standValue);
  /** The next way along (or the one before), from flat when they differ. */
  const cycleStand = (step: 1 | -1) => {
    const from = standIndex < 0 ? (step > 0 ? -1 : 0) : standIndex;
    const next = STAND_CHOICES[(from + step + STAND_CHOICES.length) % STAND_CHOICES.length][0];
    toggleStand(next === "" ? undefined : next);
  };
  // Their ramp, if alike ("" flat); -1 when they differ.
  const ramps = new Set(terrainShapes.map((shape) => getTerrainRamp(shape) ?? ""));
  const rampIndex = ramps.size === 1 ? RAMP_CHOICES.findIndex(([value]) => value === [...ramps][0]) : -1;
  const cycleRamp = (step: 1 | -1) => {
    const from = rampIndex < 0 ? (step > 0 ? -1 : 0) : rampIndex;
    const next = RAMP_CHOICES[(from + step + RAMP_CHOICES.length) % RAMP_CHOICES.length][0];
    setRamps((next || undefined) as TerrainRamp | undefined);
  };
  const wallIndex = WALL_CHOICES.findIndex(([value]) => value === wall);
  /** The next style along (or the one before), from Auto when they differ. */
  const cycleWalls = (step: 1 | -1) => {
    const from = wallIndex < 0 ? (step > 0 ? -1 : 0) : wallIndex;
    const next = WALL_CHOICES[(from + step + WALL_CHOICES.length) % WALL_CHOICES.length][0];
    setWalls((next || undefined) as TerrainWallStyle | undefined);
  };
  const disabled = terrainShapes.length === 0;
  // The Vistazo's own rows, only while it's on (see createTerrainMenu).
  const vistazoOn = new URLSearchParams(window.location.search).get("vistazo") !== "0";
  const cloth = shapes.length > 0 && shapes.every(getTerrainCloth);
  // A zone and a plain shape (no height) selected together: the shape can be the zone's picture.
  const plain = shapes.filter((shape) => getTerrainHeight(shape) === undefined);
  const canLink = terrainShapes.length === 1 && plain.length === 1;
  const linked = terrainShapes.some((shape) => getTerrainSkin(shape) !== undefined);
  async function toggleSkin() {
    const ids = terrainShapes.map((shape) => shape.id);
    const source = linked ? undefined : plain[0]?.id;
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        setTerrainSkin(draft, source);
      }
    });
    setShapes(await OBR.scene.items.getItems(selection));
  }
  return (
    <div className="picker-stack terrain-picker" role="group" aria-label={t("terrain.label")}>
      <UnitStepper
        label={t("terrain.height")}
        current={sharedHeight(shapes)}
        gridScale={gridScale}
        onStep={(direction) => apply((height) => height + direction)}
        onSet={(height) => apply(() => height)}
        end={
          <button
            className="step-button icon-button"
            disabled={!anyTerrain}
            title={t("terrain.remove")}
            aria-label={t("terrain.remove")}
            onClick={() => apply(undefined)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM8 9h8v10H8V9Zm7.5-5-1-1h-5l-1 1H5v2h14V4h-3.5Z" fill="currentColor" />
            </svg>
          </button>
        }
      />
      <div title={t("terrain.underHint")}>
        <UnitStepper
          label={t("terrain.under")}
          current={sharedUnder(shapes)}
          gridScale={gridScale}
          onStep={(direction) => applyUnder((cells) => cells + direction)}
          onSet={(cells) => applyUnder(() => cells)}
          fine
          end={<span className="step-button icon-button" aria-hidden="true" style={{ visibility: "hidden" }} />}
        />
      </div>
      <div className="step-row" role="group" aria-label={t("terrain.cloth")} title={t("terrain.clothHint")}>
        <span className="row-label">{t("terrain.cloth")}</span>
        <button
          className={cloth ? "step-button ground active" : "step-button ground"}
          style={{ flex: 1, marginLeft: 0 }}
          disabled={shapes.length === 0}
          aria-pressed={cloth}
          onClick={() => void setCloth(!cloth)}
        >
          {t(cloth ? "terrain.clothOff" : "terrain.clothOn")}
        </button>
      </div>
      <div className="step-row" role="group" aria-label={t("terrain.ramp")} title={t("terrain.rampHint")}>
        <span className="row-label">{t("terrain.ramp")}</span>
        <button
          className="step-button"
          disabled={disabled}
          title={t("terrain.standPrevious")}
          aria-label={t("terrain.standPrevious")}
          onClick={() => cycleRamp(-1)}
        >
          ‹
        </button>
        <span className="step-field wall-value" aria-live="polite" title={rampIndex < 0 ? undefined : t(RAMP_CHOICES[rampIndex][2])}>
          {rampIndex < 0 ? "—" : t(RAMP_CHOICES[rampIndex][1])}
        </span>
        <button
          className="step-button"
          disabled={disabled}
          title={t("terrain.standNext")}
          aria-label={t("terrain.standNext")}
          onClick={() => cycleRamp(1)}
        >
          ›
        </button>
      </div>
      {vistazoOn && (
        <>
        <div className="section-title" title={t("terrain.vistazoHint")}>
          {t("terrain.vistazo")}
        </div>
        <div className="step-row" role="group" aria-label={t("terrain.stand")} title={t("terrain.standHint")}>
          <span className="row-label">{t("terrain.stand")}</span>
          <button
            className="step-button"
            disabled={disabled}
            title={t("terrain.standPrevious")}
            aria-label={t("terrain.standPrevious")}
            onClick={() => cycleStand(-1)}
          >
            ‹
          </button>
          <span className="step-field wall-value" aria-live="polite" title={standIndex < 0 ? undefined : t(STAND_CHOICES[standIndex][2])}>
            {standIndex < 0 ? "—" : t(STAND_CHOICES[standIndex][1])}
          </span>
          <button
            className="step-button"
            disabled={disabled}
            title={t("terrain.standNext")}
            aria-label={t("terrain.standNext")}
            onClick={() => cycleStand(1)}
          >
            ›
          </button>
        </div>
        <div className="step-row" role="group" aria-label={t("terrain.walls")} title={t("terrain.wallsHint")}>
          <span className="row-label">{t("terrain.walls")}</span>
          <button
            className="step-button"
            disabled={disabled}
            title={t("terrain.wallsPrevious")}
            aria-label={t("terrain.wallsPrevious")}
            onClick={() => cycleWalls(-1)}
          >
            ‹
          </button>
          <span className="step-field wall-value" aria-live="polite">
            {wallIndex < 0 ? "—" : t(WALL_CHOICES[wallIndex][1])}
          </span>
          <button
            className="step-button"
            disabled={disabled}
            title={t("terrain.wallsNext")}
            aria-label={t("terrain.wallsNext")}
            onClick={() => cycleWalls(1)}
          >
            ›
          </button>
        </div>
        <div className="step-row" role="group" aria-label={t("terrain.skin")} title={t("terrain.skinHint")}>
          <span className="row-label">{t("terrain.skin")}</span>
          <button
            className={linked ? "step-button ground active" : "step-button ground"}
            style={{ flex: 1, marginLeft: 0 }}
            disabled={!linked && !canLink}
            aria-pressed={linked}
            onClick={() => void toggleSkin()}
          >
            {t(linked ? "terrain.skinUnlink" : "terrain.skinLink")}
          </button>
        </div>
        <div title={t("terrain.waterHint")}>
          <UnitStepper
            label={t("terrain.water")}
            current={sharedWater(shapes)}
            gridScale={gridScale}
            onStep={(direction) => applyWater((cells) => cells + direction)}
            onSet={(cells) => applyWater(() => cells)}
            fine
            end={<span className="step-button icon-button" aria-hidden="true" style={{ visibility: "hidden" }} />}
          />
        </div>
        </>
      )}
    </div>
  );
}
