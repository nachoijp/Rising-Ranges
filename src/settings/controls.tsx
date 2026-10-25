import { useEffect, useState, type ReactNode } from "react";
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
  warning,
}: {
  id: string;
  label: string;
  tooltip: string;
  /** A warning icon beside the label, with this as its tooltip (see FieldLabel). */
  warning?: string;
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
        <FieldLabel id={id} tooltip={tooltip} warning={warning}>
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

/**
 * A section folded shut until opened, under its label. `open`/`onOpenChange`
 * to open it from elsewhere (see MapaTab's "Propio").
 */
export function FoldedSection({
  label,
  children,
  open: shown,
  onOpenChange,
}: {
  label: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = (next: (value: boolean) => boolean) => {
    const value = next(open);
    setOwn(value);
    onOpenChange?.(value);
  };
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
        sx={{ alignSelf: "flex-start", opacity: 0.75, fontSize: 12, letterSpacing: "0.06em" }}
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

/** Space between a tab's sections (and a folded section's own). */
export const SECTION_GAP = "14px";

/**
 * "Volver a los valores de fábrica" for a tab, at its end: a first click asks
 * (the button says so), a second within a few seconds resets.
 */
export function ResetButton({ onReset }: { onReset: () => void }) {
  const t = useTranslation();
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) {
      return;
    }
    const timer = setTimeout(() => setAsking(false), 4000);
    return () => clearTimeout(timer);
  }, [asking]);
  return (
    <Button
      size="small"
      color={asking ? "warning" : "primary"}
      onClick={() => {
        if (asking) {
          setAsking(false);
          onReset();
        } else {
          setAsking(true);
        }
      }}
      sx={{ alignSelf: "flex-end", textTransform: "none" }}
    >
      {asking ? t("settings.resetConfirm") : t("settings.reset")}
    </Button>
  );
}
