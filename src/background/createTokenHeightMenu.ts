import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import heightIcon from "../assets/height.svg";
import footprintIcon from "../assets/footprint.svg";
import terrainIcon from "../assets/terrain.svg";
import { type Language } from "../i18n/language";
import { translate } from "../i18n/translate";
import type { HeightStep } from "../engine/types";

/**
 * A token's footprint and height set by hand (see footprint.ts): the
 * Elevation entry's last two sections (see ElevationPanel). Its own entry
 * only while the Elevation one is off.
 */
export function createTokenFootprintMenu(language: Language) {
  OBR.contextMenu.create({
    id: getPluginId("menu/tokenFootprint"),
    icons: [
      {
        icon: footprintIcon,
        label: translate(language, "footprint.label"),
        filter: {
          every: [
            { key: "layer", value: "CHARACTER" },
            { key: "type", value: "IMAGE" },
          ],
          permissions: ["UPDATE"],
        },
      },
    ],
    // The 8px padding around both sections, without the divider above the first.
    embed: { url: "/token-height.html?view=footprint", height: 16 + FOOTPRINT_SECTION_HEIGHT - 17 },
  });
}

/** Item types that can't be terrain (see canBeTerrain). */
const NOT_TERRAIN_TYPES = ["IMAGE", "TEXT", "LABEL", "LINE", "RULER", "POINTER", "WALL", "LIGHT", "EFFECT", "GRID"];

/**
 * A shape's "Terrain height" (see terrain.ts), for the GM: how high the
 * ground is inside it, on the same page as the height picker.
 */
export function createTerrainMenu(language: Language) {
  OBR.contextMenu.create({
    id: getPluginId("menu/terrain"),
    icons: [
      {
        icon: terrainIcon,
        label: translate(language, "terrain.label"),
        filter: {
          roles: ["GM"],
          // Terrain is part of the map (see terrain.ts): its shapes, curves
          // and paths. Written as "on the Map and none of the other types":
          // with "||" between the types, a curve or path on any layer got in.
          every: [
            { key: "layer", value: "MAP" },
            ...NOT_TERRAIN_TYPES.map((type) => ({ key: "type", value: type, operator: "!=" as const })),
          ],
        },
      },
    ],
    // The stepper's row and the remove button below it, plus padding.
    embed: { url: "/token-height.html?view=terrain", height: 96 },
  });
}

/**
 * The token's elevation — a table of Bandas, or one row to step cell by
 * cell — with its footprint and its own height below, in one entry.
 * "Elevation" is how high a token is; "Height", how tall it is.
 */
export function createTokenHeightMenu(language: Language, heightStep: HeightStep) {
  OBR.contextMenu.create({
    id: getPluginId("menu/tokenHeight"),
    icons: [
      {
        icon: heightIcon,
        label: translate(language, "toolbar.altura"),
        filter: {
          every: [
            { key: "layer", value: "CHARACTER" },
            { key: "type", value: "IMAGE" },
          ],
          permissions: ["UPDATE"],
        },
      },
    ],
    embed: {
      url: "/token-height.html?view=elevation",
      // Bandas: 160 clipped the bottom row live; 210 left too much empty
      // space below it. Splitting the difference — still an estimate.
      // Cells: one 36px row plus the 8px padding around it.
      height: (heightStep === "unit" ? 52 : 185) + SECTION_TITLE_HEIGHT + FOOTPRINT_SECTION_HEIGHT,
    },
  });
}

/** Each section's title (.section-title). */
const SECTION_TITLE_HEIGHT = 20;
/** The footprint (its sizes and a custom size) and the token's height under the elevation, each after a divider and its title. */
const FOOTPRINT_SECTION_HEIGHT = 17 + SECTION_TITLE_HEIGHT + 36 + 8 + 36 + 17 + SECTION_TITLE_HEIGHT + 36;
