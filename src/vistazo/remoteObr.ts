import OBR from "@owlbear-rodeo/sdk";
import { DragSender, OWN_CHANNEL, REMOTE_DRAG_CHANNEL, WATCHING_KEY, type Fixed, type Measured, type OwnMessage } from "./remote";

// The Owlbear side of remote.ts: who's watching, and this page's drags out.

let watchers: Set<string> | null = null;

/** Whether some other client has its Vistazo open (see WATCHING_KEY): kept up to date from the first call. */
export function othersWatching(): boolean {
  if (!watchers) {
    watchers = new Set();
    const take = (players: { connectionId: string; metadata: Record<string, unknown> }[]) => {
      watchers = new Set(players.filter((player) => player.metadata?.[WATCHING_KEY] === true).map((player) => player.connectionId));
    };
    OBR.party.onChange(take);
    OBR.party.getPlayers().then(take, () => {});
  }
  return watchers.size > 0;
}

let said: boolean | null = null;

/** This client's Vistazo open or not, told the others (only when it changes: a player's metadata goes to everyone). */
export function setWatching(on: boolean) {
  if (said === on) {
    return;
  }
  said = on;
  OBR.player.setMetadata({ [WATCHING_KEY]: on }).catch((error) => {
    said = null;
    console.warn("Rising Ranges: couldn't tell the others whether the Vistazo is open", error);
  });
}

let sender: DragSender | null = null;

/** This page's drags, out to the other clients' Vistazos (see DragSender). */
export function dragSender(): DragSender {
  // The background page's: the map's Medición's (see RemoteDrag's `medicion`).
  const medicion = typeof location !== "undefined" && location.pathname.endsWith("background.html");
  sender ??= new DragSender((message) => OBR.broadcast.sendMessage(REMOTE_DRAG_CHANNEL, message, { destination: "REMOTE" }), othersWatching, () => Date.now(), medicion);
  return sender;
}

let own: Measured | null = null;
let fixed: Fixed | null = null;
let answering = false;

/** How often this client's Vistazo is told (ms, at most), and again after a message lost. */
const OWN_INTERVAL_MS = 60;
const OWN_RETRY_MS = 300;

/**
 * What's up now, told this client's Vistazo: at most every OWN_INTERVAL_MS (a Medición from a point
 * moves every frame), the latest always last; a message lost (Owlbear's rate limit), told again.
 */
function teller(message: () => OwnMessage) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = -Infinity;
  const send = () => {
    timer = null;
    last = Date.now();
    OBR.broadcast.sendMessage(OWN_CHANNEL, message(), { destination: "LOCAL" }).catch(() => {
      timer ??= setTimeout(send, OWN_RETRY_MS);
    });
  };
  return () => {
    timer ??= setTimeout(send, Math.max(0, last + OWN_INTERVAL_MS - Date.now()));
  };
}
const tellOwn = teller(() => ({ type: "own", measured: own }));
const tellFixed = teller(() => ({ type: "fixed", fixed }));

/** Background script: a Vistazo opened meanwhile asks, and is told what's up. */
function answer() {
  if (answering) {
    return;
  }
  answering = true;
  OBR.broadcast.onMessage(OWN_CHANNEL, (event) => {
    if ((event.data as OwnMessage | null)?.type === "hello") {
      tellOwn();
      tellFixed();
    }
  });
}

/** Background script: the Medición fija shown on this screen (null: none), told this client's Vistazo. */
export function tellFixedMedicion(value: Fixed | null) {
  answer();
  const next = value && { center: { x: value.center.x, y: value.center.y }, height: value.height, radius: value.radius };
  if (JSON.stringify(next) !== JSON.stringify(fixed)) {
    fixed = next;
    tellFixed();
  }
}

/** Background script: this client's Medición, what it measures from (null: over), told this client's Vistazo. */
export function tellOwnMedicion(measured: Measured | null) {
  answer();
  if (JSON.stringify(measured) !== JSON.stringify(own)) {
    own = measured;
    tellOwn();
  }
}
