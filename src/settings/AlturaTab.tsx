import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { IconShape } from "../engine/types";
import { ICON_SHAPES } from "../render/iconStack";
import { FieldLabel } from "./FieldLabel";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { IconPositionButtonGroup } from "./IconPositionButtonGroup";
import { SHAPE_LABEL_KEYS, ShapePreview } from "./ShapePreview";
import { LabeledSlider } from "./LabeledSlider";
import { ChoiceGroup, FoldedSection, ResetButton, SECTION_GAP, SettingSwitch } from "./controls";
import { useTranslation } from "../i18n/useTranslation";
import { FACTORY_DISPLAY, SIZE_RANGES, type DisplaySettings } from "./display";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_HOTKEY_GROUND, groundHotkey, type GlobalSettings, type MarkerStyle } from "./globalSettings";
import { clearAllTokenHeightMarkers } from "../tokenHeight/markers";
import { liftsOn } from "../engine/axonometry";
import { useOBRContext } from "./OBRContext";

/** Everything about height in one place: the feature itself, how markers look, its menu and its hotkeys. */
export function AlturaTab({
  settings,
  onChangeSettings,
  display,
  onChangeDisplay,
}: {
  settings: GlobalSettings;
  onChangeSettings: (patch: Partial<GlobalSettings>) => void;
  display: DisplaySettings;
  onChangeDisplay: (patch: Partial<DisplaySettings>) => void;
}) {
  const t = useTranslation();
  const enabled = settings.enableAltitude ?? true;
  const marker = display.marker;
  // The perspective options only do something on these grids: kept, but not to be changed, on others.
  const lifts = liftsOn(useOBRContext().gridType);

  function onToggleAltitude(next: boolean) {
    onChangeSettings({ enableAltitude: next });
    // Turning altitude off is meant to fully erase the concept (plain
    // Ranges behavior) — leaving old markers sitting on tokens with no way
    // left to see/edit them would be confusing, so they go with it.
    if (!next) {
      clearAllTokenHeightMarkers();
    }
  }

  /** Everything here back as a new room has it, the feature itself aside. */
  function reset() {
    onChangeSettings({
      markerStyle: DEFAULT_GLOBAL_SETTINGS.markerStyle,
      showAltitudeMenu: DEFAULT_GLOBAL_SETTINGS.showAltitudeMenu,
      hotkeyRaise: DEFAULT_GLOBAL_SETTINGS.hotkeyRaise,
      hotkeyLower: DEFAULT_GLOBAL_SETTINGS.hotkeyLower,
      hotkeyGround: DEFAULT_HOTKEY_GROUND,
      isoLift: undefined,
      isoShadow: undefined,
      isoTether: undefined,
      isoSunkHead: undefined,
      // In the same change: two in a row would each start from the same old settings.
      display: { ...display, iconShape: FACTORY_DISPLAY.iconShape, marker: FACTORY_DISPLAY.marker },
    });
  }

  return (
    <Stack gap={SECTION_GAP} sx={{ pt: 1 }}>
      <Stack>
        <Stack sx={{ px: 1 }}>
          <FieldLabel id="enable-altitude-label" tooltip={t("settings.global.enableAltitudeTooltip")}>
            {t("settings.global.enableAltitude")}
          </FieldLabel>
        </Stack>
        <SettingSwitch
          label={t("settings.global.enableAltitudeToggle")}
          checked={enabled}
          onChange={onToggleAltitude}
        />
      </Stack>

      {enabled && (
        <>
          <ChoiceGroup<MarkerStyle>
            id="marker-style-label"
            label={t("settings.global.markerStyle")}
            tooltip={t("settings.global.markerStyleTooltip")}
            value={settings.markerStyle ?? "icons"}
            onChange={(markerStyle) => onChangeSettings({ markerStyle })}
            options={[
              { value: "icons", label: t("settings.global.markerStyleIcons") },
              { value: "label", label: t("settings.global.markerStyleLabel") },
              { value: "both", label: t("settings.global.markerStyleBoth") },
            ]}
          />

          <SettingSwitch
            label={t("settings.global.altitudeMenuToggle")}
            checked={settings.showAltitudeMenu}
            onChange={(showAltitudeMenu) => onChangeSettings({ showAltitudeMenu })}
          />

          <FoldedSection label={t("settings.altura.hotkeys")}>
            <Stack sx={{ px: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {t("settings.altura.hotkeysTooltip")}
              </Typography>
              <Stack direction="row" gap={1} justifyContent="space-around" sx={{ mt: 0.5 }}>
                <HotkeyRecorder
                  label={t("settings.global.hotkeyRaise")}
                  value={settings.hotkeyRaise}
                  reservedLetters={[settings.hotkeyActivate, settings.hotkeyLower, groundHotkey(settings)]}
                  onChange={(hotkeyRaise) => onChangeSettings({ hotkeyRaise })}
                />
                <HotkeyRecorder
                  label={t("settings.global.hotkeyLower")}
                  value={settings.hotkeyLower}
                  reservedLetters={[settings.hotkeyActivate, settings.hotkeyRaise, groundHotkey(settings)]}
                  onChange={(hotkeyLower) => onChangeSettings({ hotkeyLower })}
                />
                <HotkeyRecorder
                  label={t("settings.global.hotkeyGround")}
                  value={groundHotkey(settings)}
                  reservedLetters={[settings.hotkeyActivate, settings.hotkeyRaise, settings.hotkeyLower]}
                  onChange={(hotkeyGround) => onChangeSettings({ hotkeyGround })}
                />
              </Stack>
            </Stack>
          </FoldedSection>

          <FoldedSection label={t("settings.altura.markerLook")}>
            <Stack sx={{ px: 1 }}>
              <FieldLabel id="icon-shape-label" tooltip={t("settings.altura.iconShapeTooltip")}>
                {t("settings.altura.iconShape")}
              </FieldLabel>
              <ToggleButtonGroup
                value={display.iconShape}
                onChange={(_, iconShape: IconShape | null) => {
                  if (iconShape) {
                    onChangeDisplay({ iconShape });
                  }
                }}
                exclusive
                aria-labelledby="icon-shape-label"
                size="small"
                fullWidth
                sx={{ my: 0.5 }}
              >
                {ICON_SHAPES.map((shape) => (
                  <ToggleButton key={shape} value={shape} aria-label={t(SHAPE_LABEL_KEYS[shape])} sx={{ px: 0 }}>
                    <Tooltip title={t(SHAPE_LABEL_KEYS[shape])}>
                      <span style={{ display: "flex" }}>
                        <ShapePreview shape={shape} />
                      </span>
                    </Tooltip>
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Stack>
            <Stack sx={{ px: 1 }}>
              <IconPositionButtonGroup
                value={marker.position}
                onChange={(position) => onChangeDisplay({ marker: { ...marker, position } })}
              />
            </Stack>
            <LabeledSlider
              id="marker-size-label"
              label={t("settings.altura.size")}
              tooltip={t("settings.altura.sizeTooltip")}
              value={marker.size}
              onChange={(size) => onChangeDisplay({ marker: { ...marker, size } })}
              min={SIZE_RANGES.marker[0]}
              max={SIZE_RANGES.marker[1]}
              step={0.1}
              valueLabelFormat={(value) => `${value.toFixed(1)}x`}
            />
            <LabeledSlider
              id="marker-opacity-label"
              label={t("settings.opacity")}
              tooltip={t("settings.altura.opacityTooltip")}
              value={Math.round(marker.opacity * 100)}
              onChange={(value) => onChangeDisplay({ marker: { ...marker, opacity: value / 100 } })}
              min={5}
              max={100}
              step={5}
              valueLabelFormat={(value) => `${value}%`}
            />
            <LabeledSlider
              id="marker-distance-label"
              label={t("settings.altura.distance")}
              tooltip={t("settings.altura.distanceTooltip")}
              value={Math.round(marker.distance * 100)}
              onChange={(value) => onChangeDisplay({ marker: { ...marker, distance: value / 100 } })}
              min={SIZE_RANGES.markerDistance[0] * 100}
              max={SIZE_RANGES.markerDistance[1] * 100}
              step={1}
              valueLabelFormat={(value) => `${value}%`}
            />
          </FoldedSection>

          <FoldedSection label={t("settings.altura.iso")}>
            <Stack>
              <Typography variant="caption" color={lifts ? "text.secondary" : "warning.main"} sx={{ px: 1 }}>
                {t(lifts ? "settings.altura.isoTooltip" : "settings.altura.isoSquare")}
              </Typography>
              <SettingSwitch
                label={t("settings.altura.isoLift")}
                checked={settings.isoLift ?? false}
                disabled={!lifts}
                onChange={(isoLift) => onChangeSettings({ isoLift })}
              />
              <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
                {t("settings.altura.isoLiftHint")}
              </Typography>
              <SettingSwitch
                label={t("settings.altura.isoShadow")}
                checked={settings.isoShadow ?? true}
                disabled={!lifts || !settings.isoLift}
                onChange={(isoShadow) => onChangeSettings({ isoShadow })}
              />
              <SettingSwitch
                label={t("settings.altura.isoTether")}
                checked={settings.isoTether ?? true}
                disabled={!lifts || !settings.isoLift}
                onChange={(isoTether) => onChangeSettings({ isoTether })}
              />
              <SettingSwitch
                label={t("settings.altura.isoSunkHead")}
                checked={settings.isoSunkHead ?? true}
                disabled={!lifts || !settings.isoLift}
                onChange={(isoSunkHead) => onChangeSettings({ isoSunkHead })}
              />
              <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
                {t("settings.altura.isoSunkHeadHint")}
              </Typography>
            </Stack>
          </FoldedSection>
          <ResetButton onReset={reset} />
        </>
      )}
    </Stack>
  );
}
