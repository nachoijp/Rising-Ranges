import OBR, { type GridType } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { languageFromMetadata } from "../i18n/language";
import { globalSettingsFromMetadata, liftsTokens, terrainOn, terrainVisibility, vistazoAccess } from "../settings/globalSettings";
import { createVistazoAction } from "./createVistazoAction";
import { createReliefMenu, RELIEF_MENU_ID } from "./createReliefMenu";
import { getGridType } from "../util/gridAxonometry";
import { createMeasureTool } from "./createMeasureTool";
import { createThemeAction } from "./createThemeAction";
import { createSettingsAction } from "./createSettingsAction";
import { createTokenFootprintMenu, createTokenHeightMenu, removeTokenMenu, type BaseShown } from "./createTokenHeightMenu";
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
/** Which of the panels' buttons are on the toolbar (see placePanelActions), to tell when that changes. */
let lastShown: string | null = null;
/** The panels' buttons are placed one registration after another (removed, then added again in order). */
let placing: Promise<unknown> = Promise.resolve();

const PANEL_ACTIONS = ["action/vistazo", "action/terrainVisibility", "action/distances"].map(getPluginId);

/**
 * The Vistazo 3D's, the terrain view's and the Distancias panel's buttons, in that order. Owlbear puts
 * a new one last: when one comes back, all of them are taken away and added again, so it goes back in
 * its place (registering one that's there replaces it where it is).
 */
function placePanelActions(shown: { vistazo: boolean; terrain: boolean; distances: boolean }, create: () => void) {
  // The first time too: Owlbear may still have them from before this page loaded, in another order.
  const key = JSON.stringify(shown);
  const reorder = key !== lastShown;
  lastShown = key;
  // One that fails doesn't stop the ones after it.
  placing = placing
    .then(async () => {
      if (reorder) {
        await Promise.all(PANEL_ACTIONS.map((id) => OBR.tool.removeAction(id).catch(() => {})));
      }
      create();
    })
    .catch((error) => console.error("Rising Ranges: toolbar", error));
}
/** The scene grid's type: terrain is left out on isometric and dimetric grids (see terrainOn). */
let gridType: GridType = "SQUARE";

export function registerToolbar(metadata: Record<string, unknown>) {
  lastMetadata = metadata;
  const language = languageFromMetadata(metadata);
  const settings = globalSettingsFromMetadata(metadata);
  const altitudeMenu = (settings.enableAltitude ?? true) && settings.showAltitudeMenu;
  const distancePanel = settings.distancePanel ?? "off";
  const vistazo = vistazoAccess(settings);
  const heightStep = heightStepOf(bandSetFromMetadata(metadata));
  const altitude = settings.enableAltitude ?? true;
  const terrain = terrainOn(settings, gridType);
  const terrainMode = terrainVisibility(settings);
  // The token's "Height when sunk" only does something while sunk tokens are drawn down by their head.
  const tall = liftsTokens(settings, gridType) && (settings.isoSunkHead ?? true);
  const signature = JSON.stringify([
    language,
    settings.hotkeyActivate,
    altitudeMenu,
    distancePanel,
    vistazo,
    heightStep,
    altitude,
    terrain,
    terrainMode,
    tall,
  ]);
  if (signature === lastSignature) {
    return;
  }
  const firstTime = lastSignature === null;
  lastSignature = signature;
  if (firstTime) {
    // The old shapes' terrain menu (gone: the terrain is made in the Vistazo now), as Owlbear may still
    // have it from an earlier version of this page.
    OBR.contextMenu.remove(getPluginId("menu/terrain")).catch(() => {});
  }

  createMeasureTool(language, settings);
  createThemeAction(language);
  createSettingsAction(language);
  // Terrain is part of heights: off with them, or turned off, or on an axonometric grid. (Its shapes
  // are made in the Vistazo now: see relief/; the old shapes' own terrain menu is gone.)
  const shown = { vistazo: vistazo !== "off", terrain, distances: distancePanel !== "off" };
  placePanelActions(shown, () => {
    if (shown.vistazo) {
      createVistazoAction(language, vistazo);
    } else if (!firstTime) {
      OBR.tool.removeAction(getPluginId("action/vistazo")).catch(() => {});
    }
    if (shown.terrain) {
      createTerrainVisibilityAction(language, terrainMode);
    } else if (!firstTime) {
      OBR.tool.removeAction(getPluginId("action/terrainVisibility")).catch(() => {});
    }
    if (shown.distances) {
      createDistancesAction(language, distancePanel);
    } else if (!firstTime) {
      OBR.tool.removeAction(getPluginId("action/distances")).catch(() => {});
    }
  });
  // The footprint is in the Elevation entry while heights are on, on its own otherwise; the Vistazo's
  // base in either, for whoever can open the Vistazo (the GM even with it hidden: the relief editor
  // shows the tokens in 3D too).
  const base: BaseShown = vistazo === "everyone" ? "all" : "gm";
  if (altitudeMenu) {
    createTokenHeightMenu(language, heightStep, tall, base);
    if (!firstTime) {
      removeTokenMenu(getPluginId("menu/tokenFootprint"));
    }
  } else {
    createTokenFootprintMenu(language, tall, base);
    if (!firstTime) {
      removeTokenMenu(getPluginId("menu/tokenHeight"));
    }
  }
  // The relief is edited in the Vistazo: its entry on the map's menu with the terrain on (the Vistazo
  // hidden too: this is how it's opened then).
  if (terrain) {
    createReliefMenu(language);
  } else if (!firstTime) {
    OBR.contextMenu.remove(RELIEF_MENU_ID).catch(() => {});
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
