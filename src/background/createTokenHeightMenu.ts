import OBR, { type ContextMenuIconFilter } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import heightIcon from "../assets/height.svg";
import footprintIcon from "../assets/footprint.svg";
import { type Language } from "../i18n/language";
import { translate } from "../i18n/translate";
import type { HeightStep } from "../engine/types";

/**
 * Who sees the Vistazo 3D's "Base" in a token's menu (see VistazoBasePicker):
 * everyone, only the GM (the Vistazo is the GM's: the players get the menu
 * without it), or no one (the Vistazo is off).
 */
export type BaseShown = "all" | "gm" | "none";

/** The images a height (and a footprint, and a base) can be set on: Character, Mount and Prop. */
const HEIGHT_IMAGES: ContextMenuIconFilter = {
  every: [
    { key: "type", value: "IMAGE" },
    ...["MAP", "GRID", "DRAWING", "ATTACHMENT", "NOTE", "TEXT", "RULER", "FOG", "POINTER", "POST_PROCESS", "CONTROL", "POPOVER"].map((layer) => ({ key: "layer", value: layer, operator: "!=" as const })),
  ],
  permissions: ["UPDATE"],
};

/**
 * One token menu, as `base` asks: one entry for everyone, or one for the
 * GM with the base and one for the players without it (Owlbear's menus
 * can't change their height by who's looking). The variant not in use is
 * taken away.
 */
function createWithBase(id: string, icon: string, label: string, base: BaseShown, embed: (withBase: boolean) => { url: string; height: number }) {
  const players = `${id}/players`;
  if (base === "gm") {
    OBR.contextMenu.create({ id, icons: [{ icon, label, filter: { ...HEIGHT_IMAGES, roles: ["GM"] } }], embed: embed(true) });
    OBR.contextMenu.create({ id: players, icons: [{ icon, label, filter: { ...HEIGHT_IMAGES, roles: ["PLAYER"] } }], embed: embed(false) });
    return;
  }
  OBR.contextMenu.create({ id, icons: [{ icon, label, filter: HEIGHT_IMAGES }], embed: embed(base === "all") });
  void OBR.contextMenu.remove(players).catch(() => {});
}

/** Takes a token menu away, both its variants (see createWithBase). */
export function removeTokenMenu(id: string) {
  void OBR.contextMenu.remove(id).catch(() => {});
  void OBR.contextMenu.remove(`${id}/players`).catch(() => {});
}

/**
 * A token's footprint and height set by hand (see footprint.ts), and its
 * base in the Vistazo: the Elevation entry's last sections (see
 * ElevationPanel). Its own entry only while the Elevation one is off, on the
 * same images as that one.
 */
export function createTokenFootprintMenu(language: Language, tall: boolean, base: BaseShown) {
  createWithBase(getPluginId("menu/tokenFootprint"), footprintIcon, translate(language, "footprint.label"), base, (withBase) => ({
    url: `/token-height.html?view=footprint${tallParam(tall)}${baseParam(withBase)}`,
    // The 8px padding around its sections, without the divider above the first.
    height: 16 + footprintSectionHeight(tall, withBase) - 17,
  }));
}

/**
 * The token's elevation — a table of Bandas, or one row to step cell by
 * cell — with its footprint, its own height and its base in the Vistazo
 * below, in one entry. "Elevation" is how high a token is; "Height", how
 * tall it is. On images of the Character, Mount and Prop layers: a prop's
 * height is drawn too (the Vistazo raises it), but only characters are
 * measured (the Medición and the Distancias panel). The filter is written as
 * "an image, on none of the other layers": with "||" between the layers, how
 * Owlbear groups it with the "&&" isn't sure (a curve or path on any layer
 * got into the old terrain menu that way).
 */
export function createTokenHeightMenu(language: Language, heightStep: HeightStep, tall: boolean, base: BaseShown) {
  createWithBase(getPluginId("menu/tokenHeight"), heightIcon, translate(language, "toolbar.altura"), base, (withBase) => ({
    url: `/token-height.html?view=elevation${tallParam(tall)}${baseParam(withBase)}`,
    // Bandas: the table's 150 px (see ElevationPanel) plus the 8px padding around it.
    // Cells: one 36px row plus the same padding.
    height: (heightStep === "unit" ? 52 : 166) + SECTION_TITLE_HEIGHT + footprintSectionHeight(tall, withBase),
  }));
}

/** Each section's title (.section-title). */
const SECTION_TITLE_HEIGHT = 20;
/**
 * The footprint (its sizes and a custom size) under the elevation, and the
 * token's height when sunk if it's shown, each after a divider and its title.
 */
function footprintSectionHeight(tall: boolean, withBase: boolean): number {
  return 17 + SECTION_TITLE_HEIGHT + 36 + 8 + 36 + (tall ? 17 + SECTION_TITLE_HEIGHT + 36 : 0) + (withBase ? BASE_SECTION_HEIGHT : 8);
}

/** The Vistazo 3D's base (see VistazoBasePicker): a divider, its title and its thumbnail, and a little room under it at the menu's bottom. */
const BASE_SECTION_HEIGHT = 17 + SECTION_TITLE_HEIGHT + 96 + 8;

/** Leaves out the "Height when sunk" section (see ElevationPanel) when it would do nothing. */
const tallParam = (tall: boolean) => (tall ? "" : "&tall=0");

/** Leaves out the Vistazo's base (see ElevationPanel) when who's looking can't open the Vistazo. */
const baseParam = (withBase: boolean) => (withBase ? "" : "&base=0");
