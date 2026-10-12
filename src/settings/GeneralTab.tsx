import { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import OpenInNewRounded from "@mui/icons-material/OpenInNewRounded";
import { FieldLabel } from "./FieldLabel";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { ChoiceGroup, SECTION_GAP } from "./controls";
import { useOBRContext } from "./OBRContext";
import { useTranslation } from "../i18n/useTranslation";
import type { Language } from "../i18n/language";
import { groundHotkey, type DistancePanelAccess, type GlobalSettings } from "./globalSettings";

const README_URL = "https://github.com/nachoijp/Rising-Ranges#readme";

/**
 * Which Rising Ranges this room has loaded — released, beta or dev — as its
 * manifest says: "Rising Ranges (beta) 1.4.0-beta.1".
 */
function useLoadedVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(new URL("/manifest.json", window.location.origin), { cache: "no-store" })
      .then((response) => response.json())
      .then((manifest: { name?: unknown; version?: unknown }) => {
        if (live && typeof manifest.name === "string" && typeof manifest.version === "string") {
          setVersion(`${manifest.name} ${manifest.version}`);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return version;
}

/** Room-wide basics: language, the tool's own shortcut, who gets the Distancias panel, and a way back to the manual. */
export function GeneralTab({
  settings,
  onChangeSettings,
}: {
  settings: GlobalSettings;
  onChangeSettings: (patch: Partial<GlobalSettings>) => void;
}) {
  const { language, onChangeLanguage } = useOBRContext();
  const t = useTranslation();
  const version = useLoadedVersion();
  return (
    <Stack gap={SECTION_GAP} sx={{ pt: 1 }}>
      <ChoiceGroup<Language>
        id="language-label"
        label={t("settings.global.language")}
        tooltip={t("settings.global.languageTooltip")}
        value={language}
        onChange={onChangeLanguage}
        options={[
          { value: "es", label: t("settings.global.languageEs") },
          { value: "en", label: t("settings.global.languageEn") },
        ]}
      />

      <Stack direction="row" alignItems="center" gap={1} sx={{ px: 1 }}>
        <Stack sx={{ flexGrow: 1 }}>
          <FieldLabel id="activate-hotkey-label" tooltip={t("settings.general.activateTooltip")}>
            {t("settings.global.hotkeyActivate")}
          </FieldLabel>
        </Stack>
        <HotkeyRecorder
          label=""
          ariaLabel={t("settings.global.hotkeyActivate")}
          value={settings.hotkeyActivate}
          reservedLetters={[settings.hotkeyRaise, settings.hotkeyLower, groundHotkey(settings)]}
          onChange={(hotkeyActivate) => onChangeSettings({ hotkeyActivate })}
        />
      </Stack>

      <ChoiceGroup<DistancePanelAccess>
        id="distance-panel-label"
        label={t("settings.global.distancePanel")}
        tooltip={t("settings.global.distancePanelTooltip")}
        value={settings.distancePanel ?? "off"}
        onChange={(distancePanel) => onChangeSettings({ distancePanel })}
        options={[
          { value: "off", label: t("settings.global.distancePanelOff") },
          { value: "gm", label: t("settings.global.distancePanelGm") },
          { value: "everyone", label: t("settings.global.distancePanelEveryone") },
        ]}
      />

      <Stack direction="row" alignItems="center" gap={1} sx={{ px: 1 }}>
        <Stack sx={{ flexGrow: 1 }}>
          <FieldLabel id="help-label" tooltip={t("settings.general.helpTooltip")}>
            {t("settings.general.help")}
          </FieldLabel>
        </Stack>
        <Button
          variant="outlined"
          size="small"
          href={README_URL}
          target="_blank"
          rel="noopener noreferrer"
          endIcon={<OpenInNewRounded fontSize="small" />}
          aria-describedby="help-label"
        >
          {t("settings.general.helpOpen")}
        </Button>
      </Stack>

      {version && (
        <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
          {version}
        </Typography>
      )}
    </Stack>
  );
}
