import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { languageFromMetadata } from "../i18n/language";
import { globalSettingsFromMetadata } from "../settings/globalSettings";
import { createMeasureTool } from "./createMeasureTool";
import { createThemeAction } from "./createThemeAction";
import { createSettingsAction } from "./createSettingsAction";
import { createTokenFootprintMenu, createTokenHeightMenu } from "./createTokenHeightMenu";
import { createDistancesAction } from "./createDistancesAction";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { heightStepOf } from "../engine/heights";

// Everything this extension adds to Owlbear's own UI — the Medición mode,
// the toolbar actions, the Altura context menu — registered from the
// current scene's settings, and again whenever those change (the labels'
// language, the activation key, which of them exist, the height picker's
// size), so no change needs a reload. Registering an id again replaces it; what's turned off is removed.

let lastSignature: string | null = null;

export function registerToolbar(metadata: Record<string, unknown>) {
  const language = languageFromMetadata(metadata);
  const settings = globalSettingsFromMetadata(metadata);
  const altitudeMenu = (settings.enableAltitude ?? true) && settings.showAltitudeMenu;
  const distancePanel = settings.distancePanel ?? "off";
  const heightStep = heightStepOf(bandSetFromMetadata(metadata));
  const signature = JSON.stringify([language, settings.hotkeyActivate, altitudeMenu, distancePanel, heightStep]);
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
}

/** Keeps the registration in step with the scene's settings: changed from Opciones, or another scene opened. */
export function watchToolbar() {
  OBR.scene.onMetadataChange(registerToolbar);
  OBR.scene.onReadyChange(async (ready) => {
    if (ready) {
      registerToolbar(await OBR.scene.getMetadata());
    }
  });
}
