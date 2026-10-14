import { useEffect, useLayoutEffect, useRef, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";

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
import { useTranslation } from "../i18n/useTranslation";
import { GLASS_FRAME } from "../util/glass";

const MODES: TerrainVisibility[] = ["hidden", "gm", "everyone"];

/** The toolbar's terrain visibility choice: one for the whole scene (see terrainStyle.ts), in the same glass popover as the others. */
export function TerrainVisibilityPicker() {
  const t = useTranslation();
  const [current, setCurrent] = useState<TerrainVisibility | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Keeps the popover as tall as its rows (like the theme popover).
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) {
      return;
    }
    let height = 0;
    const observer = new ResizeObserver(() => {
      const next = Math.ceil(element.offsetHeight) + GLASS_FRAME;
      if (next !== height) {
        height = next;
        OBR.popover.setHeight(TERRAIN_VISIBILITY_POPOVER_ID, next);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
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
    <List ref={listRef} role="radiogroup" aria-label={t("terrain.visibility")} sx={{ p: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
      {MODES.map((mode) => (
        <ListItemButton
          key={mode}
          role="radio"
          aria-checked={current === mode}
          selected={current === mode}
          onClick={() => choose(mode)}
          sx={{ borderRadius: "10px", minHeight: 40, py: 0.5 }}
        >
          <ListItemIcon sx={{ minWidth: 34 }}>
            {/* The icon as a mask over the text color, so it follows the theme like Owlbear's toolbar does. */}
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                backgroundColor: "currentColor",
                maskImage: `url("${TERRAIN_VISIBILITY_ICONS[mode]}")`,
                WebkitMaskImage: `url("${TERRAIN_VISIBILITY_ICONS[mode]}")`,
                maskSize: "contain",
                WebkitMaskSize: "contain",
              }}
            />
          </ListItemIcon>
          <ListItemText
            primary={t(TERRAIN_VISIBILITY_LABELS[mode])}
            sx={{ my: 0 }}
            slotProps={{ primary: { fontWeight: 500, fontSize: 14, noWrap: true } }}
          />
        </ListItemButton>
      ))}
    </List>
  );
}
