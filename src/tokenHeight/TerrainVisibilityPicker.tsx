import { useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";

import {
  getGlobalSettings,
  globalSettingsFromMetadata,
  setGlobalSettings,
  terrainVisibility,
  type TerrainVisibility,
} from "../settings/globalSettings";
import {
  TERRAIN_VISIBILITY_ICONS,
  TERRAIN_VISIBILITY_LABELS,
  TERRAIN_VISIBILITY_POPOVER_ID,
} from "../background/createTerrainVisibilityAction";
import { watchTheme } from "./theme";
import { useTranslation } from "../i18n/useTranslation";

import "./tokenHeight.css";

const MODES: TerrainVisibility[] = ["hidden", "gm", "everyone"];

/** The toolbar's terrain visibility choice: one for the whole scene (see terrainStyle.ts). */
export function TerrainVisibilityPicker() {
  const t = useTranslation();
  const [current, setCurrent] = useState<TerrainVisibility | null>(null);

  useEffect(() => {
    watchTheme();
    getGlobalSettings().then((settings) => setCurrent(terrainVisibility(settings)));
    return OBR.scene.onMetadataChange((metadata) => setCurrent(terrainVisibility(globalSettingsFromMetadata(metadata))));
  }, []);

  async function choose(mode: TerrainVisibility) {
    setCurrent(mode);
    // Read again just before writing: another setting may have changed meanwhile.
    const settings = await getGlobalSettings();
    await setGlobalSettings({ ...settings, terrainVisibility: mode });
    await OBR.popover.close(TERRAIN_VISIBILITY_POPOVER_ID);
  }

  return (
    <div className="picker-stack" role="radiogroup" aria-label={t("terrain.visibility")}>
      {MODES.map((mode) => (
        <button
          key={mode}
          role="radio"
          aria-checked={current === mode}
          className={current === mode ? "step-button active" : "step-button"}
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, textAlign: "left" }}
          onClick={() => choose(mode)}
        >
          {/* The icon as a mask over the text color, so it follows the theme like Owlbear's toolbar does. */}
          <span
            aria-hidden
            style={{
              width: 20,
              height: 20,
              flex: "none",
              backgroundColor: "currentColor",
              maskImage: `url("${TERRAIN_VISIBILITY_ICONS[mode]}")`,
              WebkitMaskImage: `url("${TERRAIN_VISIBILITY_ICONS[mode]}")`,
              maskSize: "contain",
              WebkitMaskSize: "contain",
            }}
          />
          {t(TERRAIN_VISIBILITY_LABELS[mode])}
        </button>
      ))}
    </div>
  );
}
