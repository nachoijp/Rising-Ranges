import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import InfoOutlined from "@mui/icons-material/InfoOutlined";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import { SmallLabel } from "./SmallLabel";

export function FieldLabel({
  id,
  children,
  tooltip,
  warning,
}: {
  id?: string;
  children: React.ReactNode;
  tooltip: React.ReactNode;
  /** A caveat worth seeing before using it: an "!" beside the info icon, with its own tooltip. */
  warning?: React.ReactNode;
}) {
  return (
    <Stack direction="row" alignItems="center" gap={0.5}>
      <SmallLabel id={id} sx={{ mb: 0 }}>
        {children}
      </SmallLabel>
      <Tooltip title={tooltip}>
        <InfoOutlined sx={{ fontSize: 14, opacity: 0.6 }} />
      </Tooltip>
      {warning && (
        <Tooltip title={warning}>
          <ErrorOutlineRounded color="warning" sx={{ fontSize: 15 }} tabIndex={0} aria-label={typeof warning === "string" ? warning : undefined} />
        </Tooltip>
      )}
    </Stack>
  );
}
