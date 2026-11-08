import type { Item, Permission } from "@owlbear-rodeo/sdk";
import OBR from "@owlbear-rodeo/sdk";

/** The layers a player needs a permission to change (their own, "<LAYER>_UPDATE"); the rest none can. */
const UPDATABLE = new Set(["MAP", "PROP", "MOUNT", "CHARACTER", "ATTACHMENT", "NOTE", "RULER", "POINTER", "TEXT", "FOG", "DRAWING"]);

export function getPermissionForItem(item: Item): Permission | undefined {
  return UPDATABLE.has(item.layer) ? (`${item.layer}_UPDATE` as Permission) : undefined;
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
