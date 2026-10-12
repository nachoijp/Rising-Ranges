import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import heightIcon from "../assets/height.svg";
import footprintIcon from "../assets/footprint.svg";
import { type Language } from "../i18n/language";
import { translate } from "../i18n/translate";
import type { HeightStep } from "../engine/types";

/**
 * A token's footprint set by hand (see footprint.ts): a row of sizes, on
 * the same page as the height picker.
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
    embed: { url: "/token-height.html?view=footprint", height: 96 },
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
