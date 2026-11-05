import { useState } from "react";

import Stack from "@mui/material/Stack";
import List from "@mui/material/List";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";

import DeleteRounded from "@mui/icons-material/DeleteRounded";
import AddRounded from "@mui/icons-material/AddRounded";
import Tooltip from "@mui/material/Tooltip";

import { BandItem } from "./BandItem";
import { shownShape, useGridType } from "./BandShapeButtonGroup";
import { getStoredTheme } from "../theme/themes";
import { BandSet, IconShape } from "../engine/types";
import { useTranslation } from "../i18n/useTranslation";
import { newBandId } from "../bandSets/library";

/** Enough for any system's distances (Draw Steel has 8); the color themes repeat past 6. */
const MAX_BANDS = 12;

export function BandSetEditor({
  bandSet,
  defaultIconShape,
  onChange,
  onDelete,
}: {
  bandSet: BandSet;
  /** The room's icon shape, which a Banda's own one overrides. */
  defaultIconShape: IconShape;
  onChange?: (bandSet: BandSet) => void;
  onDelete?: (bandSet: BandSet) => void;
}) {
  const [theme] = useState(() => getStoredTheme());
  const t = useTranslation();
  // The Bandas' icons in the shape they're drawn in on this grid (see shownShape).
  const shape = shownShape(bandSet.shape, useGridType());

  function addBand() {
    const maxRadius = Math.max(...bandSet.bands.map((b) => b.radius));
    onChange?.({
      ...bandSet,
      bands: [
        ...bandSet.bands,
        {
          name: t("settings.band.newName", { n: bandSet.bands.length + 1 }),
          radius: maxRadius + 1,
          id: newBandId(bandSet.bands),
        },
      ],
    });
  }

  const maxRadius = Math.max(...bandSet.bands.map((b) => b.radius));
  // Fudge the numbers a bit so the graph looks better.
  // We add 1 so the min radius is 2 as log(1) is 0 and we want to start at 1
  const logMaxRadius = Math.log(maxRadius + 1);

  return (
    <Stack gap={1} sx={{ overflowY: "auto", pb: 1 }}>
      <Box sx={{ flexGrow: 1 }}>
        <List disablePadding>
          {bandSet.bands.map((band, i, bands) => {
            const color = theme.colors[i % theme.colors.length];
            const logRadius = Math.log(band.radius + 1);
            const logComplete = logRadius / logMaxRadius;
            return (
              <BandItem
                key={band.id}
                band={band}
                color={color}
                complete={logComplete}
                iconRadius={i + 1}
                bandIndex={i}
                onChange={
                  onChange
                    ? (band) => {
                        const newBands = [...bands];
                        newBands[i] = band;
                        onChange?.({ ...bandSet, bands: newBands });
                      }
                    : undefined
                }
                onDelete={
                  onChange
                    ? () => {
                        const newBands = [...bands];
                        newBands.splice(i, 1);
                        onChange?.({ ...bandSet, bands: newBands });
                      }
                    : undefined
                }
                // Name on the left, radius on the right — what the ring
                // labels show on the map is a Mapa setting now.
                hideSize
                bandShape={shape}
                defaultIconShape={defaultIconShape}
              />
            );
          })}
        </List>
      </Box>
      {onChange && (
        <Button
          variant="outlined"
          fullWidth
          size="small"
          onClick={addBand}
          disabled={bandSet.bands.length >= MAX_BANDS}
          startIcon={<AddRounded />}
        >
          {t("settings.bandSetEditor.addBanda")}
        </Button>
      )}
      {onChange && onDelete && (
        <Controls bandSet={bandSet} onChange={onChange} onDelete={onDelete} />
      )}
    </Stack>
  );
}

function Controls({
  bandSet,
  onChange,
  onDelete,
}: {
  bandSet: BandSet;
  onChange: (bandSet: BandSet) => void;
  onDelete: (bandSet: BandSet) => void;
}) {
  const [localName, setLocalName] = useState(bandSet.name);
  const t = useTranslation();
  return (
    <>
      <Divider sx={{ my: 1 }} />
      <Stack direction="row" gap={1} alignItems="center">
        <TextField
          label={t("common.name")}
          aria-labelledby="name-label"
          value={localName}
          onChange={(e) =>
            e.target.value.length < 50 && setLocalName(e.target.value)
          }
          onBlur={() => onChange({ ...bandSet, name: localName })}
          size="small"
          sx={{ flexGrow: 1 }}
        />
        <Tooltip title={t("common.delete")}>
          <IconButton onClick={() => onDelete(bandSet)} color="error">
            <DeleteRounded />
          </IconButton>
        </Tooltip>
      </Stack>
    </>
  );
}
