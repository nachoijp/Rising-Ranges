import OBR, { type GridType } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { languageFromMetadata } from "../i18n/language";
import { globalSettingsFromMetadata, terrainOn, terrainVisibility } from "../settings/globalSettings";
import { getGridType } from "../util/gridAxonometry";
import { createMeasureTool } from "./createMeasureTool";
import { createThemeAction } from "./createThemeAction";
import { createSettingsAction } from "./createSettingsAction";
import { createTerrainMenu, createTokenFootprintMenu, createTokenHeightMenu } from "./createTokenHeightMenu";
import { createTerrainVisibilityAction } from "./createTerrainVisibilityAction";
import { createDistancesAction } from "./createDistancesAction";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { heightStepOf } from "../engine/heights";

// Everything this extension adds to Owlbear's own UI — the Medición mode,
// the toolbar actions, the Altura context menu — registered from the
// current scene's settings, and again whenever those change (the labels'
// language, the activation key, which of them exist, the height picker's
// size), so no change needs a reload. Registering an id again replaces it; what's turned off is removed.

let lastSignature: string | null = null;
let lastMetadata: Record<string, unknown> = {};
/** The scene grid's type: terrain is left out on isometric and dimetric grids (see terrainOn). */
let gridType: GridType = "SQUARE";

export function registerToolbar(metadata: Record<string, unknown>) {
  lastMetadata = metadata;
  const language = languageFromMetadata(metadata);
  const settings = globalSettingsFromMetadata(metadata);
  const altitudeMenu = (settings.enableAltitude ?? true) && settings.showAltitudeMenu;
  const distancePanel = settings.distancePanel ?? "off";
  const heightStep = heightStepOf(bandSetFromMetadata(metadata));
  const altitude = settings.enableAltitude ?? true;
  const terrain = terrainOn(settings, gridType);
  const terrainMode = terrainVisibility(settings);
  const signature = JSON.stringify([
    language,
    settings.hotkeyActivate,
    altitudeMenu,
    distancePanel,
    heightStep,
    altitude,
    terrain,
    terrainMode,
  ]);
  if (signature === lastSignature) {
    return;
  }
  const firstTime = lastSignature === null;
  lastSignature = signature;

  createMeasureTool(language, settings);
  createThemeAction(language);
  createSettingsAction(language);
  if (distancePanel !== "off") {
    createDistancesAction(language, distancePanel);
  } else if (!firstTime) {
    OBR.tool.removeAction(getPluginId("action/distances"));
  }
  createTokenFootprintMenu(language);
  if (altitudeMenu) {
    createTokenHeightMenu(language, heightStep);
  } else if (!firstTime) {
    OBR.contextMenu.remove(getPluginId("menu/tokenHeight"));
  }
  // Terrain is part of heights: off with them, or turned off, or on an axonometric grid.
  if (terrain) {
    createTerrainMenu(language);
    createTerrainVisibilityAction(language, terrainMode);
  } else if (!firstTime) {
    OBR.contextMenu.remove(getPluginId("menu/terrain"));
    OBR.tool.removeAction(getPluginId("action/terrainVisibility"));
  }
}

/** Keeps the registration in step with the scene's settings: changed from Opciones, or another scene opened. */
export function watchToolbar() {
  OBR.scene.onMetadataChange(registerToolbar);
  getGridType()
    .then((type) => {
      gridType = type;
      registerToolbar(lastMetadata);
    })
    .catch(() => {});
  OBR.scene.grid.onChange((grid) => {
    gridType = grid.type;
    registerToolbar(lastMetadata);
  });
  OBR.scene.onReadyChange(async (ready) => {
    if (ready) {
      registerToolbar(await OBR.scene.getMetadata());
    }
  });
}
