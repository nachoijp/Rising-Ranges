import { useEffect, useState } from "react";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { FieldLabel } from "./FieldLabel";

export function LabeledSlider({
  id,
  label,
  tooltip,
  value,
  onChange,
  disabled,
  min,
  max,
  step,
  marks,
  valueLabelFormat,
}: {
  id: string;
  label: string;
  tooltip: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  min: number;
  max: number;
  step: number;
  marks?: { value: number; label: string }[];
  valueLabelFormat?: (value: number) => string;
}) {
  // MUI fires onChange on every pixel of a drag; each call of the prop is
  // a scene write. The value is kept here while dragging and only passed
  // on once, when the slider is let go (onChangeCommitted).
  const [localValue, setLocalValue] = useState(value);
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  return (
    <Stack sx={{ px: 1 }}>
      {/* Its value at the label's far end, always shown (as the Vistazo's sliders), not in a bubble over the thumb. */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <FieldLabel id={id} tooltip={tooltip}>
          {label}
        </FieldLabel>
        <Typography component="output" aria-hidden sx={{ fontSize: 12, color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
          {valueLabelFormat ? valueLabelFormat(localValue) : localValue}
        </Typography>
      </Stack>
      <Slider
        aria-labelledby={id}
        value={localValue}
        onChange={(_, value) => {
          if (typeof value === "number") {
            setLocalValue(value);
          }
        }}
        onChangeCommitted={(_, value) => {
          if (typeof value === "number") {
            onChange(value);
          }
        }}
        step={step}
        min={min}
        max={max}
        marks={marks}
        valueLabelDisplay="off"
        valueLabelFormat={valueLabelFormat}
        size="small"
        disabled={disabled}
        sx={{
          // Room for the thumb's halo (20px past the track's ends while held; the tab clips
          // sideways): 12px each side, on top of the 8px the row has.
          mx: "12px",
          width: "calc(100% - 24px)",
          // The first and last mark labels are aligned to the track's
          // edges instead of centered, so they don't stick out past it.
          "& .MuiSlider-markLabel[data-index='0']": {
            transform: "translateX(0%)",
          },
          ...(marks && {
            [`& .MuiSlider-markLabel[data-index='${marks.length - 1}']`]: {
              transform: "translateX(-100%)",
            },
          }),
        }}
      />
    </Stack>
  );
}
