import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import { IconShape } from "../engine/types";
import { ICON_SHAPES } from "../render/iconStack";
import { SHAPE_LABEL_KEYS, ShapePreview } from "./ShapePreview";
import { useTranslation } from "../i18n/useTranslation";
import { useRoomyMenu } from "../util/menuRoom";

/** Per-Banda icon shape override — a compact trigger since BandItem's row has no room for a full Select. */
export function BandIconShapeMenu({
  value,
  defaultShape,
  onChange,
  disabled,
}: {
  /** This Banda's own override, or undefined to use the BandSet's default. */
  value: IconShape | undefined;
  /** The BandSet's default shape, shown when this Banda has no override. */
  defaultShape: IconShape;
  onChange: (value: IconShape | undefined) => void;
  disabled?: boolean;
}) {
  const menu = useRoomyMenu<HTMLElement>();
  const effectiveShape = value ?? defaultShape;
  const t = useTranslation();

  return (
    <>
      <Tooltip title={t("settings.bandIconShape.tooltip")}>
        <span>
          <IconButton
            size="small"
            sx={{ p: 0.25 }}
            disabled={disabled}
            // Its name on the button itself: the Tooltip's goes to the span around it (there for when it's disabled).
            aria-label={t("settings.bandIconShape.tooltip")}
            onClick={(e) => menu.open(e.currentTarget)}
          >
            <ShapePreview shape={effectiveShape} />
          </IconButton>
        </span>
      </Tooltip>
      <Menu anchorEl={menu.anchor} open={menu.isOpen} onClose={menu.close}>
        <MenuItem
          selected={value === undefined}
          onClick={() => {
            onChange(undefined);
            menu.close();
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <ShapePreview shape={defaultShape} />
          </ListItemIcon>
          <ListItemText>{t("common.default")}</ListItemText>
        </MenuItem>
        {ICON_SHAPES.map((shape) => (
          <MenuItem
            key={shape}
            selected={value === shape}
            onClick={() => {
              onChange(shape);
              menu.close();
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <ShapePreview shape={shape} />
            </ListItemIcon>
            <ListItemText>{t(SHAPE_LABEL_KEYS[shape])}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
