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
  sender ??= new DragSender((message) => OBR.broadcast.sendMessage(REMOTE_DRAG_CHANNEL, message, { destination: "REMOTE" }), othersWatching);
  return sender;
}

let own: Measured | null = null;
let fixed: Fixed | null = null;
let answering = false;

const tellOwn = () => OBR.broadcast.sendMessage(OWN_CHANNEL, { type: "own", measured: own } satisfies OwnMessage, { destination: "LOCAL" }).catch(() => {});
const tellFixed = () => OBR.broadcast.sendMessage(OWN_CHANNEL, { type: "fixed", fixed } satisfies OwnMessage, { destination: "LOCAL" }).catch(() => {});

/** Background script: a Vistazo opened meanwhile asks, and is told what's up. */
function answer() {
  if (answering) {
    return;
  }
  answering = true;
  OBR.broadcast.onMessage(OWN_CHANNEL, (event) => {
    if ((event.data as OwnMessage | null)?.type === "hello") {
      void tellOwn();
      void tellFixed();
    }
  });
}

/** Background script: the Medición fija shown on this screen (null: none), told this client's Vistazo. */
export function tellFixedMedicion(value: Fixed | null) {
  answer();
  const next = value && { center: { x: value.center.x, y: value.center.y }, height: value.height, radius: value.radius };
  if (JSON.stringify(next) !== JSON.stringify(fixed)) {
    fixed = next;
    void tellFixed();
  }
}

/** Background script: this client's Medición, what it measures from (null: over), told this client's Vistazo. */
export function tellOwnMedicion(measured: Measured | null) {
  answer();
  if (JSON.stringify(measured) !== JSON.stringify(own)) {
    own = measured;
    void tellOwn();
  }
}
