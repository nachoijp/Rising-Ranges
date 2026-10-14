import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { FieldLabel } from "./FieldLabel";
import { LabeledSlider } from "./LabeledSlider";
import { ChoiceGroup, SECTION_GAP, SettingSwitch } from "./controls";
import { useTranslation } from "../i18n/useTranslation";
import {
  resolveTerrainLook,
  type GlobalSettings,
  type GroundLevel,
  type TerrainLook,
} from "./globalSettings";

/**
 * Terrain with a height (see terrain.ts): whether it's on, what heights are
 * shown from, and how zones are drawn (see terrainView.ts).
 */
export function TerrenoTab({
  settings,
  onChangeSettings,
}: {
  settings: GlobalSettings;
  onChangeSettings: (changes: Partial<GlobalSettings>) => void;
}) {
  const t = useTranslation();
  const altitude = settings.enableAltitude ?? true;
  const enabled = altitude && (settings.enableTerrain ?? true);
  const look = resolveTerrainLook(settings);
  const onChangeLook = (changes: Partial<TerrainLook>) =>
    onChangeSettings({ terrainLook: { ...look, ...changes } });

  if (!altitude) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2 }}>
        {t("settings.terreno.needsAltitude")}
      </Typography>
    );
  }

  return (
    <Stack gap={SECTION_GAP} sx={{ pt: 1 }}>
      <Stack>
        <Stack sx={{ px: 1 }}>
          <FieldLabel
            id="terrain-label"
            tooltip={t("settings.altura.terrainTooltip")}
            warning={t("settings.altura.terrainHint")}
          >
            {t("settings.altura.terrain")}
          </FieldLabel>
        </Stack>
        <SettingSwitch
          label={t("settings.altura.enableTerrain")}
          checked={settings.enableTerrain ?? true}
          onChange={(enableTerrain) => onChangeSettings({ enableTerrain })}
        />
      </Stack>

      {enabled && (
        <>
          <ChoiceGroup<GroundLevel>
            id="ground-level-label"
            label={t("settings.altura.groundLevel")}
            tooltip={t("settings.altura.groundLevelTooltip")}
            value={settings.groundLevel ?? "terrain"}
            onChange={(groundLevel) => onChangeSettings({ groundLevel })}
            options={[
              { value: "terrain", label: t("settings.altura.groundLevelTerrain") },
              { value: "fixed", label: t("settings.altura.groundLevelFixed") },
            ]}
          />

          <ChoiceGroup<TerrainLook["style"]>
            id="terrain-style-label"
            label={t("settings.terreno.style")}
            tooltip={t("settings.terreno.styleTooltip")}
            value={look.style}
            onChange={(style) => onChangeLook({ style })}
            options={[
              { value: "outline", label: t("settings.terreno.styleOutline") },
              { value: "layers", label: t("settings.terreno.styleLayers") },
            ]}
          />

          {look.style === "layers" && (
            <>
              <ChoiceGroup<TerrainLook["color"]>
                id="terrain-color-label"
                label={t("settings.terreno.color")}
                tooltip={t("settings.terreno.colorTooltip")}
                value={look.color}
                onChange={(color) => onChangeLook({ color })}
                options={[
                  { value: "grey", label: t("settings.terreno.colorGrey") },
                  { value: "height", label: t("settings.terreno.colorHeight") },
                ]}
              />
              <LabeledSlider
                id="terrain-shadow"
                label={t("settings.terreno.shadow")}
                tooltip={t("settings.terreno.shadowTooltip")}
                value={look.shadow}
                onChange={(shadow) => onChangeLook({ shadow })}
                min={0}
                max={100}
                step={5}
                valueLabelFormat={(value) => `${value}%`}
              />
              <LabeledSlider
                id="terrain-opacity"
                label={t("settings.terreno.opacity")}
                tooltip={t("settings.terreno.opacityTooltip")}
                value={look.opacity}
                onChange={(opacity) => onChangeLook({ opacity })}
                min={10}
                max={100}
                step={5}
                valueLabelFormat={(value) => `${value}%`}
              />
              <Stack>
                <SettingSwitch
                  label={t("settings.terreno.outline")}
                  checked={look.outline}
                  onChange={(outline) => onChangeLook({ outline })}
                />
                <SettingSwitch
                  label={t("settings.terreno.labels")}
                  checked={look.labels}
                  onChange={(labels) => onChangeLook({ labels })}
                />
              </Stack>
            </>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
            {t("settings.terreno.visibilityHint")}
          </Typography>
        </>
      )}
    </Stack>
  );
}
