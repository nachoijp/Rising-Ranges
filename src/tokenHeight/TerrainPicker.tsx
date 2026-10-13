import { useEffect, useState } from "react";
import OBR, { type Item } from "@owlbear-rodeo/sdk";

import { useOBRContext } from "../settings/OBRContext";
import { clampHeight } from "../engine/heights";
import { canBeTerrain, getTerrainHeight, setTerrainHeight } from "../terrain/terrain";
import { UnitStepper } from "./TokenHeightPicker";
import { watchTheme } from "./theme";
import { useTranslation } from "../i18n/useTranslation";

import "./tokenHeight.css";

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
      }
    });
    setShapes(await OBR.scene.items.getItems(ids));
  }

  if (shapes.length === 0) {
    return <div style={{ fontSize: 13, opacity: 0.7 }}>{t("terrain.selectShape")}</div>;
  }

  const anyTerrain = shapes.some((shape) => getTerrainHeight(shape) !== undefined);
  return (
    <div className="picker-stack" role="group" aria-label={t("terrain.label")}>
      <UnitStepper
        current={sharedHeight(shapes)}
        gridScale={gridScale}
        onStep={(direction) => apply((height) => height + direction)}
        onSet={(height) => apply(() => height)}
      />
      <button className="step-button ground" style={{ marginLeft: 0 }} disabled={!anyTerrain} onClick={() => apply(undefined)}>
        {t("terrain.remove")}
      </button>
    </div>
  );
}
