import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { BandShape } from "../engine/types";
import Stack from "@mui/material/Stack";
import Circle from "@mui/icons-material/CircleRounded";
import Square from "@mui/icons-material/SquareRounded";
import Hexagon from "@mui/icons-material/HexagonRounded";
import OBR, { type GridType } from "@owlbear-rodeo/sdk";
import { useEffect, useState } from "react";
import { getGridType } from "../util/gridAxonometry";
import { FieldLabel } from "./FieldLabel";
import { useTranslation } from "../i18n/useTranslation";

/** Buttons of a group that shares its row with another (see ShapeAndFinalBand): the same height whether they hold an icon or text. */
export const HALF_ROW_BUTTON_SX = { height: 32, py: 0, textTransform: "none" } as const;

const isHexGrid = (type: GridType | null) => type === "HEX_HORIZONTAL" || type === "HEX_VERTICAL";

/** The scene grid's type, kept up as it changes; null until it's known. */
export function useGridType(): GridType | null {
  const [type, setType] = useState<GridType | null>(null);
  useEffect(() => {
    getGridType().then(setType);
    return OBR.scene.grid.onChange((grid) => setType(grid.type));
  }, []);
  return type;
}

/**
 * The shape shown in the settings for a set's own: as it's drawn on this grid. Hex off a hex grid is
 * drawn as a circle (see shapeOnGrid), but kept in the set, for when the grid's hex again.
 */
export function shownShape(shape: BandShape, type: GridType | null): BandShape {
  return shape === "hex" && type !== null && !isHexGrid(type) ? "circle" : shape;
}

export function BandShapeButtonGroup({
  value,
  onChange,
}: {
  value: BandShape;
  onChange: (value: BandShape) => void;
}) {
  const t = useTranslation();
  // Hex only means something on a hex grid (see hex.ts): offered there only. Off one, a set's hex
  // shows as the circle it's drawn as (still hex in the set, until another's picked).
  const gridType = useGridType();
  const shown = shownShape(value, gridType);
  return (
    <Stack>
      <FieldLabel id="band-shape-label" tooltip={t("settings.bandShape.tooltip")}>
        {t("common.shape")}
      </FieldLabel>
      <ToggleButtonGroup
        value={shown}
        onChange={(_, picked) => {
          // The circle shown for a hex off a hex grid, picked: kept as a circle now.
          if (picked || shown !== value) {
            onChange(picked ?? shown);
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
        {(isHexGrid(gridType) || shown === "hex") && (
          <ToggleButton value="hex" aria-label={t("settings.bandShape.hexAria")} sx={HALF_ROW_BUTTON_SX}>
            <Hexagon fontSize="small" />
          </ToggleButton>
        )}
      </ToggleButtonGroup>
    </Stack>
  );
}
