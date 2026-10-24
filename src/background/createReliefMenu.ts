import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import vistazoIcon from "../assets/vistazo.svg";
import { type Language } from "../i18n/language";
import { translate } from "../i18n/translate";

// "Editar relieve" on a map image's right-click menu, for the GM: the
// Vistazo opened in full screen straight in the relief editor, on that
// image (not only from the Vistazo's own panel, a step further away).
// Registered again whenever the language changes (see toolbar.ts), and
// removed with the terrain or the Vistazo.

export const RELIEF_MENU_ID = getPluginId("menu/relief");
/** The Vistazo's full-screen window (see vistazo/main.ts). */
const FULL_MODAL_ID = getPluginId("vistazo/full");

export function createReliefMenu(language: Language) {
  OBR.contextMenu.create({
    id: RELIEF_MENU_ID,
    icons: [
      {
        icon: vistazoIcon,
        label: translate(language, "relief.editHere"),
        filter: {
          max: 1,
          roles: ["GM"],
          every: [
            { key: "layer", value: "MAP" },
            { key: "type", value: "IMAGE" },
          ],
        },
      },
    ],
    onClick(context) {
      const image = context.items[0];
      if (image) {
        void OBR.modal.open({ id: FULL_MODAL_ID, url: `/vistazo.html?full&edit&image=${encodeURIComponent(image.id)}`, fullScreen: true });
      }
    },
  });
}
