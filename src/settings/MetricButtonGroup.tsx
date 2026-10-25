import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { DistanceMetric } from "../engine/types";
import { FieldLabel } from "./FieldLabel";
import { MetricDiagram } from "./MetricDiagram";
import { FIRST_STEP } from "./metricDrawing";
import { useTranslation } from "../i18n/useTranslation";
import type { TranslationKey } from "../i18n/translate";

const METRIC_LABEL_KEYS: Record<DistanceMetric, TranslationKey> = {
  spherical: "settings.metric.spherical",
  cubic: "settings.metric.cubic",
  cylindrical: "settings.metric.cylindrical",
  octagonal: "settings.metric.octagonal",
};

const METRIC_DESCRIPTION_KEYS: Record<DistanceMetric, TranslationKey> = {
  spherical: "settings.metric.sphericalDesc",
  cubic: "settings.metric.cubicDesc",
  cylindrical: "settings.metric.cylindricalDesc",
  octagonal: "settings.metric.octagonalDesc",
};

/** The name each is known by elsewhere (Euclidean, longest leg…). */
const METRIC_COMMON_KEYS: Record<DistanceMetric, TranslationKey> = {
  spherical: "settings.metric.sphericalCommon",
  cubic: "settings.metric.cubicCommon",
  cylindrical: "settings.metric.cylindricalCommon",
  octagonal: "settings.metric.octagonalCommon",
};

/** Octagonal's is its two steps, each in its colour on the diagram (see OctagonalFormula). */
const METRIC_FORMULA_KEYS: Record<Exclude<DistanceMetric, "octagonal">, TranslationKey> = {
  spherical: "settings.metric.sphericalFormula",
  cubic: "settings.metric.cubicFormula",
  cylindrical: "settings.metric.cylindricalFormula",
};

/** The octagonal mode's formula: a and ½b make s (FIRST_STEP), then s and ½c (the accent, the result), as on its diagram. */
function OctagonalFormula() {
  const t = useTranslation();
  const s = t("settings.metric.groundLetter");
  return (
    <Typography variant="caption" sx={{ fontWeight: 500 }}>
      <Typography component="span" variant="inherit" sx={{ color: FIRST_STEP }}>
        a + ½b = {s}
      </Typography>
      {" → "}
      <Typography component="span" variant="inherit" sx={{ color: "primary.main" }}>
        {s} + ½c
      </Typography>
    </Typography>
  );
}

export function MetricButtonGroup({
  value,
  onChange,
  disabled,
}: {
  value: DistanceMetric;
  onChange: (value: DistanceMetric) => void;
  disabled?: boolean;
}) {
  const t = useTranslation();
  // Laid out like ChoiceGroup (controls.tsx), which every other row of
  // toggle buttons uses; this one only differs in its options' tooltips.
  return (
    <Stack sx={{ px: 1 }}>
      <FieldLabel id="metric-label" tooltip={t("settings.metric.tooltip")}>
        {t("settings.metric.label")}
      </FieldLabel>
      <ToggleButtonGroup
        value={value}
        onChange={(_, value) => {
          if (value) {
            onChange(value);
          }
        }}
        exclusive
        disabled={disabled}
        aria-labelledby="metric-label"
        size="small"
        fullWidth
        sx={{
          my: 0.5,
        }}
      >
        {(Object.keys(METRIC_LABEL_KEYS) as DistanceMetric[]).map((metric) => (
          <Tooltip
            key={metric}
            // Wide enough for its diagram (shown large: see MetricDiagram); above the buttons, where
            // there's room for it (below, the panel ends sooner).
            placement="top"
            slotProps={{ tooltip: { sx: { maxWidth: 280 } } }}
            title={
              <Stack alignItems="center" sx={{ p: 0.5, textAlign: "center" }}>
                <MetricDiagram metric={metric} />
                <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.5 }}>
                  {t(METRIC_LABEL_KEYS[metric])}
                </Typography>
                <Typography variant="caption" sx={{ opacity: 0.75 }}>
                  {t(METRIC_COMMON_KEYS[metric])}
                </Typography>
                <Typography variant="caption" sx={{ mt: 0.75 }}>
                  {t(METRIC_DESCRIPTION_KEYS[metric])}
                </Typography>
                {metric === "octagonal" ? (
                  <OctagonalFormula />
                ) : (
                  <Typography variant="caption" sx={{ color: "primary.main", fontWeight: 500 }}>
                    {t(METRIC_FORMULA_KEYS[metric])}
                  </Typography>
                )}
                <Typography variant="caption" sx={{ opacity: 0.75, mt: 0.5 }}>
                  {metric === "octagonal"
                    ? t("settings.metric.lettersOctagonal", { s: t("settings.metric.groundLetter") })
                    : t("settings.metric.letters")}
                </Typography>
              </Stack>
            }
          >
            <ToggleButton value={metric} sx={{ px: 0.5, textTransform: "none" }}>
              {t(METRIC_LABEL_KEYS[metric])}
            </ToggleButton>
          </Tooltip>
        ))}
      </ToggleButtonGroup>
    </Stack>
  );
}
