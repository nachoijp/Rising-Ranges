import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import vistazoIcon from "../assets/vistazo.svg";
import { type Language } from "../i18n/language";
import { translate } from "../i18n/translate";
import { type DistancePanelAccess } from "../settings/globalSettings";
import { toggleVistazoPanel, watchVistazoPanel } from "../vistazo/panel";

// The Vistazo 3D's button, in the Medición's toolbar like the Distancias
// one: registered again whenever who gets it changes (see toolbar.ts), and
// removed when it's turned off. The panel re-checks the setting live too.
export function createVistazoAction(language: Language, access: DistancePanelAccess) {
  if (access === "off") {
    return;
  }
  watchVistazoPanel();
  OBR.tool.createAction({
    id: getPluginId("action/vistazo"),
    icons: [
      {
        icon: vistazoIcon,
        label: translate(language, "vistazo.title"),
        filter: {
          activeTools: ["rodeo.owlbear.tool/measure"],
          ...(access === "gm" ? { roles: ["GM" as const] } : {}),
        },
      },
    ],
    onClick() {
      void toggleVistazoPanel();
    },
  });
}
