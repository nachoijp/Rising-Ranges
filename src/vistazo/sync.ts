import { getPluginId } from "../util/getPluginId";
import type { Camera } from "./render";

// "Sync my view": while the GM has it on, their Vistazo's camera goes to the
// players several times a second (and every couple of seconds even when it's
// still, for anyone who opens it late), and theirs follow it. A player's
// panel opens by itself if it's closed (see the background script). Only the
// camera: each player keeps their own fog and options.

export const SYNC_CHANNEL = getPluginId("vistazo/sync");

/**
 * A GM's camera (with when they began syncing: of two GMs syncing, the one
 * who began last is followed, the other stops), or the end of the sync.
 */
export type SyncMessage = { type: "camera"; camera: Camera; since: number } | { type: "stop" };

/** How often a moving camera is sent, at most (ms), and a still one again. */
export const SYNC_INTERVAL_MS = 120;
export const SYNC_HEARTBEAT_MS = 2000;
/** Without a message for this long, a player's camera is theirs again (the GM closed their panel). */
export const SYNC_TIMEOUT_MS = 5000;
