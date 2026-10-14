import { useState } from "react";

import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import ListItemIcon from "@mui/material/ListItemIcon";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import InputAdornment from "@mui/material/InputAdornment";
import CloseRounded from "@mui/icons-material/CloseRounded";
import IconButton from "@mui/material/IconButton";
import { keyframes } from "@mui/material/styles";

import { type Band, type BandShape, type IconShape } from "../engine/types";
import { Color } from "../theme/themes";
import NumberField from "../util/NumberField";
import { useOBRContext } from "./OBRContext";
import { flattenGridScale, gridUnit } from "../util/flattenGridScale";
import { BandIconShapeMenu } from "./BandIconShapeMenu";
import { useTranslation } from "../i18n/useTranslation";

const slideInRight = keyframes`
  from {
    width: 0;
  }
  to {
    width: var(--width);
  }
`;

export function BandItem({
  band,
  color,
  complete,
  iconRadius,
  onChange,
  onDelete,
  bandIndex,
  hideSize,
  hideLabel,
  bandShape,
  defaultIconShape,
}: {
  color: Color;
  band: Band;
  complete: number;
  iconRadius: number;
  onChange?: (band: Band) => void;
  onDelete?: () => void;
  bandIndex: number;
  hideSize?: boolean;
  hideLabel?: boolean;
  bandShape: BandShape;
  defaultIconShape: IconShape;
}) {
  const { gridScale } = useOBRContext();
  const t = useTranslation();
  const [localName, setLocalName] = useState(band.name);

  const primary = onChange ? (
    <TextField
      value={localName}
      onChange={(e) =>
        e.target.value.length < 50 && setLocalName(e.target.value)
      }
      onBlur={() => onChange({ ...band, name: localName })}
      size="small"
      slotProps={{
        input: {
          sx: {
            bgcolor: "background.paper",
            backgroundImage: (theme) =>
              theme.palette.mode === "dark"
                ? "linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1))"
                : undefined,
          },
        },
      }}
    />
  ) : (
    <ListItemText
      primary={`${hideLabel ? "" : band.name}${
        !hideLabel && !hideSize && band.name ? " " : ""
      }${hideSize ? "" : flattenGridScale(gridScale, band.radius)}`}
    />
  );

  const secondary = onChange ? (
    <NumberField
      aria-label={t("settings.band.radiusAriaLabel")}
      variant="outlined"
      numberToText={(value) =>
        `${(value * gridScale.parsed.multiplier).toFixed(
          gridScale.parsed.digits
        )}`
      }
      textToNumber={(value) => parseFloat(value) / gridScale.parsed.multiplier}
      step={1}
      min={1}
      max={1000}
      size="small"
      value={band.radius}
      onChange={(value) => onChange({ ...band, radius: value })}
      autoComplete="off"
      // Wide enough for a three-digit radius plus its unit ("300 ft"); the
      // icon and delete buttons beside it are kept tight to make the room.
      sx={{ width: "100px", flexShrink: 0 }}
      slotProps={{
        input: {
          endAdornment: (
            <InputAdornment position="end">
              {gridUnit(gridScale).trim()}
            </InputAdornment>
          ),
          inputProps: {
            sx: {
              textAlign: "inherit",
            },
          },
          sx: {
            bgcolor: "background.paper",
            backgroundImage: (theme) =>
              theme.palette.mode === "dark"
                ? "linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1))"
                : undefined,
          },
        },
      }}
    />
  ) : hideSize ? (
    <ListItemText
      secondary={flattenGridScale(gridScale, band.radius)}
      sx={{ textAlign: "end" }}
    />
  ) : null;

  return (
    <ListItem
      sx={{
        position: "relative",
        my: 0.5,
        pl: 1,
        pr: 0.5,
        gap: 0.5,
        py: onChange ? 0 : "1px",
      }}
      disablePadding
    >
      {primary}
      {secondary}
      {!onChange && (
        <ListItemIcon sx={{ opacity: 0.7, minWidth: 0 }}>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {bandShape === "hex" || bandShape === "hexHorizontal" || bandShape === "hexVertical" ? (
              <polygon
                points={[0, 60, 120, 180, 240, 300]
                  .map((deg) => `${12 + iconRadius * Math.cos(((deg + 30) * Math.PI) / 180)},${12 + iconRadius * Math.sin(((deg + 30) * Math.PI) / 180)}`)
                  .join(" ")}
                stroke="currentColor"
                strokeWidth="2"
              />
            ) : bandShape === "circle" ? (
              <circle
                cx="12"
                cy="12"
                r={iconRadius}
                stroke="currentColor"
                strokeWidth="2"
              />
            ) : (
              <rect
                x={12 - iconRadius}
                y={12 - iconRadius}
                width={iconRadius * 2}
                height={iconRadius * 2}
                stroke="currentColor"
                strokeWidth="2"
              />
            )}
          </svg>
        </ListItemIcon>
      )}
      {onChange && (
        <BandIconShapeMenu
          value={band.iconShape}
          defaultShape={defaultIconShape}
          onChange={(iconShape) => onChange({ ...band, iconShape })}
        />
      )}
      {onDelete && (
        <IconButton size="small" onClick={onDelete} sx={{ p: 0.25 }}>
          <CloseRounded />
        </IconButton>
      )}
      <Box
        style={{ "--width": `${complete * 100}%` } as React.CSSProperties}
        sx={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          zIndex: -1,
          backgroundColor: `rgb(${color.r}, ${color.g}, ${color.b})`,
          borderTopLeftRadius: "8px",
          borderBottomLeftRadius: "8px",
          borderTopRightRadius: "20px",
          borderBottomRightRadius: "20px",
          animation: (theme) =>
            `${slideInRight} ${theme.transitions.duration.shorter}ms ease-out ${
              bandIndex * 100
            }ms both`,
          "@media (prefers-reduced-motion: reduce)": {
            animation: "none",
            width: "var(--width)",
          },
          opacity: 0.2,
        }}
      />
    </ListItem>
  );
}
