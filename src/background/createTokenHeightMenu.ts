import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import heightIcon from "../assets/height.svg";
import terrainIcon from "../assets/terrain.svg";
import { type Language } from "../i18n/language";
import { translate } from "../i18n/translate";
import type { HeightStep } from "../engine/types";

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
          // Terrain is part of the map (see terrain.ts).
          every: [
            { key: "layer", value: "MAP" },
            { key: "type", value: "SHAPE", coordinator: "||" },
            { key: "type", value: "CURVE", coordinator: "||" },
            { key: "type", value: "PATH" },
          ],
        },
      },
    ],
    // The stepper's row and the remove button below it, plus padding.
    embed: { url: "/token-height.html?view=terrain", height: 96 },
  });
}

/** The picker's height: a table of Bandas, or one row to step cell by cell. */
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
      url: "/token-height.html",
      // Bandas: 160 clipped the bottom row live; 210 left too much empty
      // space below it. Splitting the difference — still an estimate.
      // Cells: one 36px row plus the 8px padding around it.
      height: heightStep === "unit" ? 52 : 185,
    },
  });
}
