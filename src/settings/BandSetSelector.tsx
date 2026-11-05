import { useRef } from "react";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import ListSubheader from "@mui/material/ListSubheader";
import Stack from "@mui/material/Stack";
import Divider from "@mui/material/Divider";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import AddRounded from "@mui/icons-material/AddRounded";
import FileDownloadRounded from "@mui/icons-material/FileDownloadRounded";
import FileUploadRounded from "@mui/icons-material/FileUploadRounded";

import { BandSet } from "../engine/types";
import IconButton from "@mui/material/IconButton";
import CheckRounded from "@mui/icons-material/CheckRounded";
import EditRounded from "@mui/icons-material/EditRounded";
import { useTranslation } from "../i18n/useTranslation";
import { useFittedMenu } from "../util/menuRoom";

/** Rows of the menu that aren't sets to pick (MUI's Select takes a ListSubheader as such): plain, not sticky. */
const plainRow = { lineHeight: 1.4, py: 0.5, bgcolor: "transparent", position: "static" } as const;

export function BandSetSelector({
  selectedBandSet,
  customBandSets,
  defaultBandSets,
  max,
  onSelect,
  onAdd,
  onEdit,
  onExport,
  onImport,
  isEditing,
  isCustom,
  outdatedBandSet,
  showEditButton,
}: {
  selectedBandSet: BandSet;
  customBandSets: BandSet[];
  defaultBandSets: BandSet[];
  /** The most custom sets the room keeps. */
  max: number;
  onSelect: (bandSet: BandSet) => void;
  onAdd: (bandSet: BandSet) => void;
  onEdit: () => void;
  /** The room's custom sets to a file. */
  onExport: () => void;
  /** Sets from a file the GM picked. */
  onImport: (file: File) => void;
  isEditing: boolean;
  isCustom: boolean;
  outdatedBandSet: boolean;
  /** The edit button only does something on the Bandas tab, so it's only shown there. */
  showEditButton: boolean;
}) {
  const t = useTranslation();
  const bandSets = [...defaultBandSets, ...customBandSets];
  // Opens downward, scrolling if the sets don't fit below it.
  const menu = useFittedMenu("down");
  const fileRef = useRef<HTMLInputElement>(null);
  const full = customBandSets.length >= max;

  function onAddBandSet() {
    if (full) {
      return;
    }
    const newBandSet = {
      ...selectedBandSet,
      id: crypto.randomUUID(),
      name: t("settings.bandSet.newName", { n: customBandSets.length + 1 }),
      bands: selectedBandSet.bands.map((band) => ({
        ...band,
        id: crypto.randomUUID(),
      })),
    };
    onAdd(newBandSet);
  }

  return (
    <Stack
      direction="row"
      gap={1}
      alignItems="center"
      sx={{ position: "relative" }}
    >
      <Select
        value={outdatedBandSet ? undefined : selectedBandSet.id}
        onChange={(event) => {
          const bandSet = bandSets.find(
            (bandSet) => bandSet.id === event.target.value
          );
          if (bandSet) {
            onSelect(bandSet);
          }
        }}
        renderValue={(value) =>
          bandSets.find((bandSet) => bandSet.id === value)?.name
        }
        {...menu.selectProps}
        MenuProps={{ ...menu.selectProps.MenuProps, elevation: 20 }}
        size="small"
        fullWidth
      >
        {defaultBandSets.map((bandSet) => (
          <MenuItem
            key={bandSet.id}
            value={bandSet.id}
            sx={{ minHeight: "auto" }}
          >
            {bandSet.name}
          </MenuItem>
        ))}
        <Divider />
        <ListSubheader sx={{ ...plainRow, fontSize: 12, color: "text.secondary" }}>
          {t("settings.bandSet.custom", { n: customBandSets.length, max })}
        </ListSubheader>
        {customBandSets.map((bandSet) => (
          <MenuItem
            key={bandSet.id}
            value={bandSet.id}
            sx={{ minHeight: "auto" }}
          >
            {bandSet.name}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={onAddBandSet}
          disabled={full}
          sx={{ justifyContent: "space-between", minHeight: "auto" }}
        >
          {t("settings.bandSet.new")}
          <AddRounded />
        </MenuItem>
        {full && (
          <ListSubheader sx={{ ...plainRow, fontSize: 12, color: "text.secondary", whiteSpace: "normal" }}>
            {t("settings.bandSet.full", { max })}
          </ListSubheader>
        )}
        <ListSubheader sx={{ ...plainRow, px: 1 }}>
          <Stack direction="row" gap={1}>
            <Tooltip title={t("settings.bandSet.exportHint")}>
              <span style={{ flex: 1, display: "flex" }}>
                <Button
                  size="small"
                  fullWidth
                  color="inherit"
                  startIcon={<FileDownloadRounded />}
                  disabled={customBandSets.length === 0}
                  onClick={() => {
                    menu.selectProps.onClose();
                    onExport();
                  }}
                >
                  {t("settings.bandSet.export")}
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={t("settings.bandSet.importHint")}>
              <Button
                size="small"
                fullWidth
                color="inherit"
                startIcon={<FileUploadRounded />}
                sx={{ flex: 1 }}
                onClick={() => {
                  menu.selectProps.onClose();
                  fileRef.current?.click();
                }}
              >
                {t("settings.bandSet.import")}
              </Button>
            </Tooltip>
          </Stack>
        </ListSubheader>
      </Select>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            onImport(file);
          }
        }}
      />
      {isCustom && !outdatedBandSet && showEditButton && (
        <IconButton onClick={onEdit} size="small">
          {isEditing ? <CheckRounded /> : <EditRounded />}
        </IconButton>
      )}
    </Stack>
  );
}
