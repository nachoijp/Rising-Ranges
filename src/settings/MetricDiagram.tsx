import { useTheme } from "@mui/material/styles";
import { DistanceMetric } from "../engine/types";
import { DIAGRAM_SIZE, metricDiagram } from "./metricDrawing";
import { useTranslation } from "../i18n/useTranslation";

/** Shown at twice its drawing's size: smaller, its letters and lines can't be read. */
const SHOWN = DIAGRAM_SIZE * 2;

/** What a calculation mode measures (see metricDrawing.ts), drawn on the tooltip it's in. */
export function MetricDiagram({ metric }: { metric: DistanceMetric }) {
  const theme = useTheme();
  const t = useTranslation();
  // Its letters' halo: the tooltip's own grey (MUI's Tooltip background).
  const halo = theme.palette.grey[700];
  return (
    <svg
      width={SHOWN}
      height={SHOWN}
      viewBox={`0 0 ${DIAGRAM_SIZE} ${DIAGRAM_SIZE}`}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: metricDiagram(metric, theme.palette.primary.main, halo, t("settings.metric.groundLetter")) }}
    />
  );
}
