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
export function createTokenFootprintMenu(language: Language, tall: boolean) {
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
    // The 8px padding around its sections, without the divider above the first.
    embed: { url: `/token-height.html?view=footprint${tallParam(tall)}`, height: 16 + footprintSectionHeight(tall) - 17 },
  });
}

/** Item types that can't be terrain (see canBeTerrain). */
/** The layers whose images can't have a height (see createTokenHeightMenu): all but Character, Mount and Prop. */
const NOT_HEIGHT_LAYERS = ["MAP", "GRID", "DRAWING", "ATTACHMENT", "NOTE", "TEXT", "RULER", "FOG", "POINTER", "POST_PROCESS", "CONTROL", "POPOVER"];

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
    // The height's, the underside's and the ramp's rows, the Vistazo 3D's title and its four rows, plus padding.
    embed: { url: "/token-height.html?view=terrain", height: 326 },
  });
}

/**
 * The token's elevation — a table of Bandas, or one row to step cell by
 * cell — with its footprint and its own height below, in one entry.
 * "Elevation" is how high a token is; "Height", how tall it is.
 */
export function createTokenHeightMenu(language: Language, heightStep: HeightStep, tall: boolean) {
  OBR.contextMenu.create({
    id: getPluginId("menu/tokenHeight"),
    icons: [
      {
        icon: heightIcon,
        label: translate(language, "toolbar.altura"),
        filter: {
          // Images on the Character, Mount and Prop layers: a prop's height is drawn too (the Vistazo
          // raises it), but only characters are measured (the Medición and the Distancias panel).
          // Written as "an image, on none of the other layers": with "||" between the layers, how
          // Owlbear groups it with the "&&" isn't sure (see the terrain menu's filter).
          every: [
            { key: "type", value: "IMAGE" },
            ...NOT_HEIGHT_LAYERS.map((layer) => ({ key: "layer", value: layer, operator: "!=" as const })),
          ],
          permissions: ["UPDATE"],
        },
      },
    ],
    embed: {
      url: `/token-height.html?view=elevation${tallParam(tall)}`,
      // Bandas: the table's 150 px (see ElevationPanel) plus the 8px padding around it.
      // Cells: one 36px row plus the same padding.
      height: (heightStep === "unit" ? 52 : 166) + SECTION_TITLE_HEIGHT + footprintSectionHeight(tall),
    },
  });
}

/** Each section's title (.section-title). */
const SECTION_TITLE_HEIGHT = 20;
/**
 * The footprint (its sizes and a custom size) under the elevation, and the
 * token's height when sunk if it's shown, each after a divider and its title.
 */
function footprintSectionHeight(tall: boolean): number {
  return 17 + SECTION_TITLE_HEIGHT + 36 + 8 + 36 + (tall ? 17 + SECTION_TITLE_HEIGHT + 36 : 0) + BASE_SECTION_HEIGHT;
}

/** The Vistazo 3D's base (see VistazoBasePicker): a divider, its title and its thumbnail, and a little room under it at the menu's bottom. */
const BASE_SECTION_HEIGHT = 17 + SECTION_TITLE_HEIGHT + 96 + 8;

/** Leaves out the "Height when sunk" section (see ElevationPanel) when it would do nothing. */
const tallParam = (tall: boolean) => (tall ? "" : "&tall=0");
