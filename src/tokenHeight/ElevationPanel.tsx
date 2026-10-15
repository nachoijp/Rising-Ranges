import { TokenHeightPicker } from "./TokenHeightPicker";
import { FootprintPicker } from "./FootprintPicker";
import { heightStepOf } from "../engine/heights";
import { useOBRContext } from "../settings/OBRContext";
import { useTranslation } from "../i18n/useTranslation";

import "./tokenHeight.css";

/**
 * The context menu's "Elevation": three titled sections — how high the
 * token is (its elevation), its footprint, and how tall it is (its
 * height). With heights off, the "Footprint" entry: the last two alone.
 * createTokenHeightMenu sizes the embed to these heights.
 */
export function ElevationPanel({ elevation = true }: { elevation?: boolean }) {
  const { bandSet } = useOBRContext();
  const t = useTranslation();
  // The picker's own area: the Bandas table, or the one row to step cell by cell.
  const pickerHeight = heightStepOf(bandSet) === "unit" ? 36 : 169;
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
      <hr className="section-divider" />
      <div className="section-title">{t("footprint.tallSection")}</div>
      <FootprintPicker part="tall" />
    </div>
  );
}
