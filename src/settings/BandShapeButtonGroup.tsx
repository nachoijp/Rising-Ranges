import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { BandShape } from "../engine/types";
import Stack from "@mui/material/Stack";
import Circle from "@mui/icons-material/CircleRounded";
import Square from "@mui/icons-material/SquareRounded";
import Hexagon from "@mui/icons-material/HexagonRounded";
import OBR from "@owlbear-rodeo/sdk";
import { useEffect, useState } from "react";
import { getGridType } from "../util/gridAxonometry";
import { FieldLabel } from "./FieldLabel";
import { useTranslation } from "../i18n/useTranslation";

/** Buttons of a group that shares its row with another (see ShapeAndFinalBand): the same height whether they hold an icon or text. */
export const HALF_ROW_BUTTON_SX = { height: 32, py: 0, textTransform: "none" } as const;

export function BandShapeButtonGroup({
  value,
  onChange,
}: {
  value: BandShape;
  onChange: (value: BandShape) => void;
}) {
  const t = useTranslation();
  // Hex only means something on a hex grid (see hex.ts): offered there, or
  // kept showing where a set already has it.
  const [hexGrid, setHexGrid] = useState(false);
  useEffect(() => {
    const isHex = (type: string) => type === "HEX_HORIZONTAL" || type === "HEX_VERTICAL";
    getGridType().then((type) => setHexGrid(isHex(type)));
    return OBR.scene.grid.onChange((grid) => setHexGrid(isHex(grid.type)));
  }, []);
  return (
    <Stack>
      <FieldLabel id="band-shape-label" tooltip={t("settings.bandShape.tooltip")}>
        {t("common.shape")}
      </FieldLabel>
      <ToggleButtonGroup
        value={value}
        onChange={(_, value) => {
          if (value) {
            onChange(value);
          }
        }}
        exclusive
        aria-labelledby="band-shape-label"
        size="small"
        fullWidth
        sx={{
          my: 0.5,
        }}
      >
        <ToggleButton value="circle" aria-label={t("settings.bandShape.circleAria")} sx={HALF_ROW_BUTTON_SX}>
          <Circle fontSize="small" />
        </ToggleButton>
        <ToggleButton value="square" aria-label={t("settings.bandShape.squareAria")} sx={HALF_ROW_BUTTON_SX}>
          <Square fontSize="small" />
        </ToggleButton>
        {(hexGrid || value === "hex") && (
          <ToggleButton value="hex" aria-label={t("settings.bandShape.hexAria")} sx={HALF_ROW_BUTTON_SX}>
            <Hexagon fontSize="small" />
          </ToggleButton>
        )}
      </ToggleButtonGroup>
    </Stack>
  );
}
