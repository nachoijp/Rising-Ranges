import { MAX_RANGES } from "../bandSets/library";
import Tooltip from "@mui/material/Tooltip";
import { useEffect, useState } from "react";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import { BandSet, HeightStep, IconShape } from "../engine/types";
import { heightStepOf } from "../engine/heights";
import { DEFAULT_TOLERANCE } from "../engine/distance";
import { BandSetEditor } from "./BandSetEditor";
import { MetricButtonGroup } from "./MetricButtonGroup";
import { LabeledSlider } from "./LabeledSlider";
import Box from "@mui/material/Box";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { ChoiceGroup, SECTION_GAP } from "./controls";
import { FieldLabel } from "./FieldLabel";
import { BandShapeButtonGroup, HALF_ROW_BUTTON_SX } from "./BandShapeButtonGroup";
import { getStoredTheme } from "../theme/themes";
import { getColorString } from "../util/color";
import { useTranslation } from "../i18n/useTranslation";

const PERCENT_MARKS = [
  { value: 0, label: "0%" },
  { value: 25, label: "25%" },
  { value: 50, label: "50%" },
  { value: 75, label: "75%" },
  { value: 100, label: "100%" },
];

/** Which distances exist and how they're measured — the BandSet itself. */
export function BandasTab({
  bandSet,
  defaultIconShape,
  isPreset,
  altitudeEnabled,
  editing,
  onChange,
  onDelete,
  onDuplicate,
  canDuplicate,
}: {
  bandSet: BandSet;
  defaultIconShape: IconShape;
  /** Built-in presets are re-read from their definition every time, so edits to one would never stick. */
  isPreset: boolean;
  /** Height steps only matter with the height feature on (the Altura tab). */
  altitudeEnabled: boolean;
  /** A custom set's Bandas list is only editable after its edit button is pressed. */
  editing: boolean;
  onChange: (bandSet: BandSet) => void;
  onDelete: (bandSet: BandSet) => void;
  onDuplicate: () => void;
  /** Whether the room has room for one more set (see bandSets/library.ts). */
  canDuplicate: boolean;
}) {
  const t = useTranslation();
  return (
    <Stack gap={SECTION_GAP} sx={{ pt: 1 }}>
      {isPreset && (
        <Alert
          severity="info"
          icon={false}
          action={
            <Tooltip title={canDuplicate ? "" : t("settings.bandSet.full", { max: MAX_RANGES })}>
              <span>
                <Button color="inherit" size="small" onClick={onDuplicate} disabled={!canDuplicate}>
                  {t("settings.bandas.duplicate")}
                </Button>
              </span>
            </Tooltip>
          }
        >
          {t("settings.bandas.presetNotice", { name: bandSet.name })}
        </Alert>
      )}
      <BandSetEditor
        bandSet={bandSet}
        defaultIconShape={defaultIconShape}
        onChange={editing ? onChange : undefined}
        onDelete={editing ? onDelete : undefined}
      />
      {!isPreset && <ShapeAndFinalBand bandSet={bandSet} onChange={onChange} />}
      <MetricButtonGroup
        value={bandSet.metric}
        onChange={(metric) => onChange({ ...bandSet, metric })}
        disabled={isPreset}
      />
      {altitudeEnabled && (
        <ChoiceGroup<HeightStep>
          id="height-step-label"
          label={t("settings.heightStep.label")}
          tooltip={t("settings.heightStep.tooltip")}
          value={heightStepOf(bandSet)}
          options={[
            { value: "band", label: t("settings.heightStep.band") },
            { value: "unit", label: t("settings.heightStep.unit") },
          ]}
          onChange={(heightStep) => onChange({ ...bandSet, heightStep })}
          disabled={isPreset}
        />
      )}
      <LabeledSlider
        id="tolerance-label"
        label={t("settings.medicion.tolerance")}
        tooltip={t("settings.medicion.toleranceTooltip")}
        value={bandSet.tolerance ?? DEFAULT_TOLERANCE}
        onChange={(tolerance) => onChange({ ...bandSet, tolerance })}
        min={0}
        max={100}
        step={1}
        marks={PERCENT_MARKS}
        valueLabelFormat={(value) => `${value}%`}
        disabled={isPreset}
      />
    </Stack>
  );
}

/**
 * The set's ring shape and its final Banda, side by side to save a row:
 * two button groups of the same size, each with its heading like every
 * other setting (so the final Banda is No/Yes, not a switch); its name
 * goes on a row of its own below, while it's on. Only for sets that can be
 * edited (not presets).
 */
function ShapeAndFinalBand({
  bandSet,
  onChange,
}: {
  bandSet: BandSet;
  onChange: (bandSet: BandSet) => void;
}) {
  const t = useTranslation();
  const enabled = bandSet.finalBand?.enabled ?? false;
  const name = bandSet.finalBand?.name || t("onMap.outOfRange");
  const [localName, setLocalName] = useState(name);
  useEffect(() => setLocalName(name), [name]);
  const theme = getStoredTheme();
  const color = theme.colors[bandSet.bands.length % theme.colors.length];

  return (
    <Stack gap={0.5}>
      <Stack direction="row" gap={2} sx={{ px: 1 }}>
        <Box sx={{ flex: 1 }}>
          <BandShapeButtonGroup value={bandSet.shape} onChange={(shape) => onChange({ ...bandSet, shape })} />
        </Box>
        <Stack sx={{ flex: 1 }}>
          <FieldLabel id="final-band-label" tooltip={t("settings.finalBand.tooltip")}>
            {t("settings.finalBand.label")}
          </FieldLabel>
          <ToggleButtonGroup
            value={enabled ? "on" : "off"}
            onChange={(_, next: "on" | "off" | null) => {
              if (next) {
                onChange({ ...bandSet, finalBand: { enabled: next === "on", name } });
              }
            }}
            exclusive
            aria-labelledby="final-band-label"
            size="small"
            fullWidth
            sx={{ my: 0.5 }}
          >
            <ToggleButton value="off" sx={HALF_ROW_BUTTON_SX}>
              {t("common.no")}
            </ToggleButton>
            <ToggleButton value="on" sx={HALF_ROW_BUTTON_SX}>
              {t("common.yes")}
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Stack>
      {enabled && (
        <Stack direction="row" alignItems="center" gap={1} sx={{ px: 1 }}>
          <span
            aria-hidden
            style={{ flexShrink: 0, width: 10, height: 10, borderRadius: "50%", background: getColorString(color) }}
          />
          <TextField
            size="small"
            label={t("settings.finalBand.name")}
            value={localName}
            onChange={(event) => event.target.value.length < 50 && setLocalName(event.target.value)}
            onBlur={() => onChange({ ...bandSet, finalBand: { enabled, name: localName.trim() || name } })}
            sx={{ flexGrow: 1 }}
          />
        </Stack>
      )}
    </Stack>
  );
}
