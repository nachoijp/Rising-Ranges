import { TokenHeightPicker } from "./TokenHeightPicker";
import { FootprintPicker } from "./FootprintPicker";
import { VistazoBasePicker } from "./VistazoBasePicker";
import { heightStepOf } from "../engine/heights";
import { useOBRContext } from "../settings/OBRContext";
import { useTranslation } from "../i18n/useTranslation";

import "./tokenHeight.css";

/**
 * The context menu's "Elevation": four titled sections — how high the
 * token is (its elevation), its footprint, how tall it is (its height,
 * only where sunk tokens are drawn down by their head), and where it
 * stands in the Vistazo 3D (its base). With the
 * Elevation entry off, the "Footprint" entry: the last two alone.
 * createTokenHeightMenu sizes the embed to these heights.
 */
export function ElevationPanel({ elevation = true }: { elevation?: boolean }) {
  // Left out when it would change nothing (see createTokenHeightMenu): only sunk tokens drawn down by their head use it.
  const tall = new URLSearchParams(window.location.search).get("tall") !== "0";
  // Left out when who's looking can't open the Vistazo (see createTokenHeightMenu).
  const base = new URLSearchParams(window.location.search).get("base") !== "0";
  const { bandSet } = useOBRContext();
  const t = useTranslation();
  // The picker's own area: the Bandas table (Banda names on up to two lines, 32 px, two rows of 52 px
  // and 3 px between them all, with a hair to spare), or the one row to step cell by cell.
  const pickerHeight = heightStepOf(bandSet) === "unit" ? 36 : 150;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {elevation && (
        <>
          <div className="section-title">{t("toolbar.altura")}</div>
          <div style={{ height: pickerHeight }}>
            <TokenHeightPicker />
          </div>
          <hr className="section-divider" />
        </>
      )}
      <div className="section-title">{t("footprint.label")}</div>
      <FootprintPicker part="footprint" />
      {tall && (
        <>
          <hr className="section-divider" />
          <div className="section-title" title={t("footprint.tallTooltip")}>
            {t("footprint.tallSection")}
          </div>
          <FootprintPicker part="tall" />
        </>
      )}
      {base && (
        <>
          <hr className="section-divider" />
          <div className="section-title" title={t("footprint.baseTooltip")}>
            {t("footprint.baseSection")}
          </div>
          <VistazoBasePicker />
        </>
      )}
    </div>
  );
}
