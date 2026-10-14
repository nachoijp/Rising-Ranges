import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { GLASS_FRAME } from "../util/glass";
import everyoneIcon from "../assets/terrain-everyone.svg";
import gmIcon from "../assets/terrain-gm.svg";
import hiddenIcon from "../assets/terrain-hidden.svg";
import { type Language } from "../i18n/language";
import { translate } from "../i18n/translate";
import type { TranslationKey } from "../i18n/translate";
import type { TerrainVisibility } from "../settings/globalSettings";

export const TERRAIN_VISIBILITY_POPOVER_ID = getPluginId("popover/terrainVisibility");

export const TERRAIN_VISIBILITY_ICONS: Record<TerrainVisibility, string> = {
  hidden: hiddenIcon,
  gm: gmIcon,
  everyone: everyoneIcon,
};

export const TERRAIN_VISIBILITY_LABELS: Record<TerrainVisibility, TranslationKey> = {
  hidden: "terrain.visibilityHidden",
  gm: "terrain.visibilityGm",
  everyone: "terrain.visibilityEveryone",
};

/** The terrain's visibility for the scene (see terrainStyle.ts), for the GM: a button showing it, opening the choice. */
export function createTerrainVisibilityAction(language: Language, mode: TerrainVisibility) {
  OBR.tool.createAction({
    id: getPluginId("action/terrainVisibility"),
    icons: [
      {
        icon: TERRAIN_VISIBILITY_ICONS[mode],
        label: `${translate(language, "terrain.visibility")}: ${translate(language, TERRAIN_VISIBILITY_LABELS[mode])}`,
        filter: {
          activeTools: ["rodeo.owlbear.tool/measure"],
          permissions: ["RULER_CREATE"],
          roles: ["GM"],
        },
      },
    ],
    onClick(_, elementId) {
      OBR.popover.open({
        id: TERRAIN_VISIBILITY_POPOVER_ID,
        url: "/terrain-visibility.html",
        // The page draws its own glass frame (GlassFrame), like the others,
        // and fits the height to its rows; wide enough for "Hidden from
        // everyone" on one line.
        width: 260 + GLASS_FRAME,
        height: 3 * 40 + 2 * 4 + 2 * 8 + GLASS_FRAME,
        hidePaper: true,
        anchorElementId: elementId,
        anchorOrigin: { horizontal: "CENTER", vertical: "BOTTOM" },
        transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
      });
    },
  });
}
