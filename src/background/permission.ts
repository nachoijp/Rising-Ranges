import type { Item, Permission } from "@owlbear-rodeo/sdk";
import OBR from "@owlbear-rodeo/sdk";

export function getPermissionForItem(item: Item): Permission | undefined {
  if (item.layer === "MAP") {
    return "MAP_UPDATE";
  } else if (item.layer === "PROP") {
    return "PROP_UPDATE";
  } else if (item.layer === "MOUNT") {
    return "MOUNT_UPDATE";
  } else if (item.layer === "CHARACTER") {
    return "CHARACTER_UPDATE";
  } else if (item.layer === "ATTACHMENT") {
    return "ATTACHMENT_UPDATE";
  } else if (item.layer === "NOTE") {
    return "NOTE_UPDATE";
  } else if (item.layer === "RULER") {
    return "RULER_UPDATE";
  } else if (item.layer === "POINTER") {
    return "POINTER_UPDATE";
  } else if (item.layer === "TEXT") {
    return "TEXT_UPDATE";
  } else if (item.layer === "FOG") {
    return "FOG_UPDATE";
  } else if (item.layer === "DRAWING") {
    return "DRAWING_UPDATE";
  } else {
    return undefined;
  }
}

/**
 * Whether a player may do `action` to an item, as the room's permissions have it (`has`): its layer's
 * permission, and with "owner only" on characters, only their own (`playerId`'s). The GM may anything.
 */
export function mayDo(item: Item, action: "CREATE" | "UPDATE" | "DELETE", has: (permission: Permission) => boolean, playerId: string): boolean {
  const permission = `${item.layer}_${action}` as Permission;
  if (!has(permission)) {
    return false;
  }
  return item.layer !== "CHARACTER" || !has("CHARACTER_OWNER_ONLY") || item.createdUserId === playerId;
}

export async function canUpdateItem(item: Item) {
  const role = await OBR.player.getRole();
  if (role === "GM") {
    return true;
  }
  const permission = getPermissionForItem(item);
  if (!permission) {
    return false;
  }
  const [hasPermission, ownerOnly] = await Promise.all([OBR.player.hasPermission(permission), OBR.player.hasPermission("CHARACTER_OWNER_ONLY")]);
  return mayDo(item, "UPDATE", (p) => (p === permission ? hasPermission : p === "CHARACTER_OWNER_ONLY" ? ownerOnly : false), OBR.player.id);
}
