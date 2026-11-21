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
        {/* Reached with the keyboard too, as the "!" beside it and the Vistazo's "i"s. */}
        <InfoOutlined
          sx={{ fontSize: 14, opacity: 0.6, borderRadius: "50%", "&:focus-visible": { opacity: 1, outline: 2, outlineColor: "primary.main", outlineOffset: 1 } }}
          tabIndex={0}
          // Its hint as its name (MUI hides an icon from screen readers without one).
          titleAccess={typeof tooltip === "string" ? tooltip : undefined}
        />
      </Tooltip>
      {warning && (
        <Tooltip title={warning}>
          <ErrorOutlineRounded color="warning" sx={{ fontSize: 15 }} tabIndex={0} titleAccess={typeof warning === "string" ? warning : undefined} />
        </Tooltip>
      )}
    </Stack>
  );
}
