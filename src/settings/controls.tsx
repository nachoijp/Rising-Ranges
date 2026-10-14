import { useState, type ReactNode } from "react";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Collapse from "@mui/material/Collapse";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import { FieldLabel } from "./FieldLabel";
import { useTranslation } from "../i18n/useTranslation";

/** One choice out of a few, as a full-width row of toggle buttons under a labelled heading. */
export function ChoiceGroup<T extends string>({
  id,
  label,
  tooltip,
  value,
  options,
  onChange,
  disabled,
  trailing,
}: {
  id: string;
  label: string;
  tooltip: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Shown at the heading's far end. */
  trailing?: ReactNode;
}) {
  return (
    <Stack sx={{ px: 1 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <FieldLabel id={id} tooltip={tooltip}>
          {label}
        </FieldLabel>
        {trailing}
      </Stack>
      <ToggleButtonGroup
        value={value}
        onChange={(_, next: T | null) => {
          if (next) {
            onChange(next);
          }
        }}
        exclusive
        aria-labelledby={id}
        size="small"
        fullWidth
        disabled={disabled}
        sx={{ my: 0.5 }}
      >
        {options.map((option) => (
          <ToggleButton key={option.value} value={option.value} sx={{ px: 0.5, textTransform: "none" }}>
            {option.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Stack>
  );
}

/** A labelled on/off switch, optionally with something after it. */
export function SettingSwitch({
  label,
  checked,
  onChange,
  disabled,
  trailing,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <Stack direction="row" alignItems="center" sx={{ px: 1 }} gap={1}>
      <FormControlLabel
        sx={{ flexGrow: 1, mr: 0 }}
        control={
          <Switch
            sx={{ overflow: "visible" }}
            checked={checked}
            onChange={(_, next) => onChange(next)}
            disabled={disabled}
          />
        }
        label={label}
      />
      {trailing}
    </Stack>
  );
}

/** A folded "Avanzado" section for the fine-tuning options most people never need. */
export function AdvancedSection({ title, children }: { title?: string; children: ReactNode }) {
  const t = useTranslation();
  return <FoldedSection label={title ? `${t("settings.advanced")} · ${title}` : t("settings.advanced")}>{children}</FoldedSection>;
}

/** A section folded shut until opened, under its label. */
export function FoldedSection({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack
      sx={{
        borderTop: 1,
        borderBottom: 1,
        borderColor: "divider",
        py: 0.5,
      }}
    >
      <Button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        size="small"
        color="inherit"
        startIcon={
          <ChevronRightRounded
            sx={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms" }}
          />
        }
        sx={{ alignSelf: "flex-start", opacity: 0.75, letterSpacing: "0.06em" }}
      >
        {label}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Stack gap={SECTION_GAP} sx={{ pt: 1, pb: 1 }}>
          {children}
        </Stack>
      </Collapse>
    </Stack>
  );
}

/** Space between a tab's sections (and an Avanzado section's own). */
export const SECTION_GAP = "14px";
