import { useState } from "react";
import Stack from "@mui/material/Stack";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import { BandSet } from "../engine/types";
import { LabeledSlider } from "./LabeledSlider";
import { FieldLabel } from "./FieldLabel";
import { useFittedMenu } from "../util/menuRoom";
import { ChoiceGroup, FoldedSection, ResetButton, SECTION_GAP, SettingSwitch } from "./controls";
import { useTranslation } from "../i18n/useTranslation";
import {
  FACTORY_DISPLAY,
  LECTURA_PRESETS,
  lecturaPresetOf,
  SIZE_RANGES,
  type DisplaySettings,
  type LecturaPreset,
  type LecturaLabel,
  type LecturaStyle,
  type RingLabel,
} from "./display";

const percent = (value: number) => `${Math.round(value * 100)}%`;
const times = (value: number) => `${value.toFixed(1)}x`;

/**
 * What appears on the map during a Medición: a look picked at once (see
 * LECTURA_PRESETS) and the filter in sight, each part of the look in "Aspecto".
 */
export function MapaTab({
  display,
  onChange,
  bandSet,
}: {
  display: DisplaySettings;
  onChange: (patch: Partial<DisplaySettings>) => void;
  bandSet: BandSet;
}) {
  const t = useTranslation();
  const style = display.lecturaStyle;
  const [lookOpen, setLookOpen] = useState(false);
  // Opens upward, scrolling if the Bandas don't fit above it.
  const filterMenu = useFittedMenu("up");
  return (
    <Stack gap={SECTION_GAP} sx={{ pt: 1 }}>
      <ChoiceGroup<LecturaPreset>
        id="lectura-preset-label"
        label={t("settings.mapa.preset")}
        tooltip={t("settings.mapa.presetTooltip")}
        value={lecturaPresetOf(display)}
        onChange={(preset) => {
          // "Propio" is whatever's set in Aspecto: opens it.
          if (preset === "custom") {
            setLookOpen(true);
          } else {
            onChange(LECTURA_PRESETS[preset]);
          }
        }}
        options={[
          { value: "minimal", label: t("settings.mapa.presetMinimal") },
          { value: "normal", label: t("settings.mapa.presetNormal") },
          { value: "full", label: t("settings.mapa.presetFull") },
          { value: "custom", label: t("settings.mapa.presetCustom") },
        ]}
      />
      <Stack>
        <Stack sx={{ px: 1 }}>
          <FieldLabel id="filter-label" tooltip={t("settings.medicion.filterTooltip")}>
            {t("settings.medicion.filter")}
          </FieldLabel>
        </Stack>
        <SettingSwitch
          label={t("settings.medicion.filterToggle")}
          checked={display.filterEnabled}
          onChange={(filterEnabled) => onChange({ filterEnabled })}
        />
        {display.filterEnabled && (
          <Select
            aria-label={t("settings.medicion.filterPlaceholder")}
            value={
              bandSet.bands.some((band) => band.id === display.filterBandId) ? display.filterBandId : ""
            }
            onChange={(e) => onChange({ filterBandId: e.target.value || undefined })}
            {...filterMenu.selectProps}
            size="small"
            displayEmpty
            sx={{ width: "60%", ml: 7 }}
          >
            <MenuItem value="">
              <em>{t("settings.medicion.filterPlaceholder")}</em>
            </MenuItem>
            {bandSet.bands.map((band) => (
              <MenuItem key={band.id} value={band.id}>
                {band.name}
              </MenuItem>
            ))}
          </Select>
        )}
      </Stack>
      <FoldedSection label={t("settings.look")} open={lookOpen} onOpenChange={setLookOpen}>
        <ChoiceGroup<LecturaStyle>
          id="lectura-style-label"
          label={t("settings.mapa.lectura")}
          tooltip={t("settings.mapa.lecturaTooltip")}
          value={style}
          onChange={(lecturaStyle) => onChange({ lecturaStyle })}
          options={[
            { value: "none", label: t("settings.mapa.none") },
            { value: "icon", label: t("settings.visualization.icon") },
            { value: "ring", label: t("settings.visualization.ring") },
            { value: "circle", label: t("settings.visualization.circle") },
          ]}
        />
        {style !== "none" && (
          <>
            {style === "icon" && (
              <LabeledSlider
                id="lectura-icon-size-label"
                label={t("settings.mapa.iconSize")}
                tooltip={t("settings.mapa.iconSizeTooltip")}
                value={display.lecturaIcon.size}
                onChange={(size) => onChange({ lecturaIcon: { ...display.lecturaIcon, size } })}
                min={SIZE_RANGES.icon[0]}
                max={SIZE_RANGES.icon[1]}
                step={0.1}
                valueLabelFormat={times}
              />
            )}
            {style === "ring" && (
              <LabeledSlider
                id="lectura-ring-size-label"
                label={t("settings.mapa.ringWidth")}
                tooltip={t("settings.mapa.ringWidthTooltip")}
                value={Math.round(display.lecturaRing.size * 100)}
                onChange={(value) => onChange({ lecturaRing: { ...display.lecturaRing, size: value / 100 } })}
                min={SIZE_RANGES.ring[0] * 100}
                max={SIZE_RANGES.ring[1] * 100}
                step={1}
                valueLabelFormat={(value) => `${value}%`}
              />
            )}
            {style === "circle" && (
              <LabeledSlider
                id="lectura-circle-size-label"
                label={t("settings.mapa.circleSize")}
                tooltip={t("settings.mapa.circleSizeTooltip")}
                value={Math.round(display.lecturaCircle.size * 100)}
                onChange={(value) => onChange({ lecturaCircle: { ...display.lecturaCircle, size: value / 100 } })}
                min={SIZE_RANGES.circle[0] * 100}
                max={SIZE_RANGES.circle[1] * 100}
                step={5}
                valueLabelFormat={(value) => `${value}%`}
              />
            )}
            <LabeledSlider
              id="lectura-opacity-label"
              label={t("settings.opacity")}
              tooltip={t("settings.mapa.opacityTooltip")}
              value={Math.round(
                (style === "icon"
                  ? display.lecturaIcon
                  : style === "ring"
                    ? display.lecturaRing
                    : display.lecturaCircle
                ).opacity * 100
              )}
              onChange={(value) => {
                const opacity = value / 100;
                if (style === "icon") {
                  onChange({ lecturaIcon: { ...display.lecturaIcon, opacity } });
                } else if (style === "ring") {
                  onChange({ lecturaRing: { ...display.lecturaRing, opacity } });
                } else {
                  onChange({ lecturaCircle: { ...display.lecturaCircle, opacity } });
                }
              }}
              min={5}
              max={100}
              step={5}
              valueLabelFormat={(value) => percent(value / 100)}
            />
          </>
        )}
        <ChoiceGroup<LecturaLabel>
          id="lectura-label-label"
          label={t("settings.mapa.lecturaLabel")}
          tooltip={t("settings.mapa.lecturaLabelTooltip")}
          value={display.lecturaLabel}
          onChange={(lecturaLabel) => onChange({ lecturaLabel })}
          options={[
            { value: "none", label: t("settings.mapa.none") },
            { value: "band", label: t("settings.mapa.labelBand") },
            { value: "distance", label: t("settings.mapa.labelDistance") },
            { value: "both", label: t("settings.mapa.labelBoth") },
          ]}
        />
        {/* Always shown: it also sizes the Origen's height label. */}
        <LabeledSlider
          id="lectura-label-size-label"
          label={t("settings.mapa.lecturaLabelSize")}
          tooltip={t("settings.mapa.lecturaLabelSizeTooltip")}
          value={display.lecturaLabelSize}
          onChange={(lecturaLabelSize) => onChange({ lecturaLabelSize })}
          min={SIZE_RANGES.label[0]}
          max={SIZE_RANGES.label[1]}
          step={0.1}
          valueLabelFormat={times}
        />
        <ChoiceGroup<RingLabel>
          id="ring-label-label"
          label={t("settings.mapa.ringLabel")}
          tooltip={t("settings.mapa.ringLabelTooltip")}
          value={display.ringLabel}
          onChange={(ringLabel) => onChange({ ringLabel })}
          options={[
            { value: "none", label: t("settings.mapa.none") },
            { value: "name", label: t("settings.mapa.labelName") },
            { value: "distance", label: t("settings.mapa.labelDistance") },
            { value: "both", label: t("settings.mapa.labelBothRing") },
          ]}
        />
        {display.ringLabel !== "none" && (
          <LabeledSlider
            id="ring-label-size-label"
            label={t("settings.mapa.ringLabelSize")}
            tooltip={t("settings.mapa.ringLabelSizeTooltip")}
            value={display.ringLabelSize}
            onChange={(ringLabelSize) => onChange({ ringLabelSize })}
            min={SIZE_RANGES.label[0]}
            max={SIZE_RANGES.label[1]}
            step={0.1}
            valueLabelFormat={times}
          />
        )}
      </FoldedSection>
      <ResetButton
        onReset={() =>
          onChange({
            lecturaStyle: FACTORY_DISPLAY.lecturaStyle,
            lecturaLabel: FACTORY_DISPLAY.lecturaLabel,
            ringLabel: FACTORY_DISPLAY.ringLabel,
            lecturaLabelSize: FACTORY_DISPLAY.lecturaLabelSize,
            ringLabelSize: FACTORY_DISPLAY.ringLabelSize,
            lecturaIcon: FACTORY_DISPLAY.lecturaIcon,
            lecturaRing: FACTORY_DISPLAY.lecturaRing,
            lecturaCircle: FACTORY_DISPLAY.lecturaCircle,
            filterEnabled: false,
            filterBandId: undefined,
          })
        }
      />
    </Stack>
  );
}
