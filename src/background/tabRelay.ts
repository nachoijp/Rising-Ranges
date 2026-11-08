import OBR, { type InteractionManager, type Item } from "@owlbear-rodeo/sdk";
import { applyPatch, type FnMark, type ItemPatch, type TabMessage } from "../obr";
import { TAB_NAME, tellTab } from "../vistazo/tab";

// The other end of the Vistazo's own tab (see src/obr.ts): the tab finds this frame among Owlbear's,
// and each of its SDK calls is made here, its answer (and each callback's call) sent back. One tab at a
// time (a new one takes over); a tab not heard from for a while is let go, its subscriptions ended.

type Linked = {
  session: string;
  /** When its page began: the newest tab's taken over by no older one. */
  since: number;
  source: Window;
  heard: number;
  /** Each subscription's ending, by its callback's number. */
  subs: Map<number, () => void>;
  interactions: Map<number, Promise<InteractionManager<Item | Item[]>>>;
  /** Callbacks the tab dropped before their subscription was made (ended as soon as it is). */
  dropped: Set<number>;
};

/** A tab not heard from for this long is let go (a hidden one's timers run once a minute). */
const QUIET_MS = 3 * 60 * 1000;
/** Kept here (this frame's storage outlives Owlbear's reloads) while a tab's linked: found again after one. */
const LINKED_KEY = "rising-ranges/tab-linked";
/** How long after it was last linked a tab is looked for (one left open overnight isn't). */
const LINKED_MS = 12 * 3600 * 1000;

const mark = (on: boolean) => {
  try {
    if (on) {
      localStorage.setItem(LINKED_KEY, String(Date.now()));
    } else {
      localStorage.removeItem(LINKED_KEY);
    }
  } catch {
    // Not kept: it's linked again by hand.
  }
};

/**
 * Owlbear reloaded with the Vistazo's tab open (linked before): the tab found by its name, without
 * opening one (a new one the browser opens, if it didn't find it, closed at once), and told where
 * Owlbear is now. It can't be, maybe (the browser keeps the tab apart from the reloaded Owlbear): it
 * says how to link it by hand then.
 */
function relink() {
  let at = 0;
  try {
    at = Number(localStorage.getItem(LINKED_KEY) ?? 0);
  } catch {
    return;
  }
  if (!at || Date.now() - at > LINKED_MS) {
    return;
  }
  let tab: Window | null = null;
  try {
    tab = window.open("", TAB_NAME);
  } catch {
    tab = null;
  }
  if (!tab) {
    return;
  }
  let blank = false;
  try {
    blank = tab.location.href === "about:blank";
  } catch {
    // Another origin's page (not ours): not a blank one.
  }
  if (blank) {
    tab.close();
    mark(false);
    return;
  }
  void tellTab(tab);
}

/** Started once in the background; `onLinked`: a tab linked or let go. */
export function startTabRelay(onLinked: (linked: boolean) => void) {
  const origin = window.origin;
  let linked: Linked | null = null;
  let handles = 0;
  relink();

  const letGo = () => {
    if (!linked) {
      return;
    }
    const old = linked;
    linked = null;
    for (const end of old.subs.values()) {
      try {
        end();
      } catch {
        // Gone already.
      }
    }
    for (const interaction of old.interactions.values()) {
      void interaction.then(([, stop]) => stop()).catch(() => {});
    }
    onLinked(false);
  };
  window.setInterval(() => {
    if (linked && Date.now() - linked.heard > QUIET_MS) {
      // Closed without a word (or asleep): not looked for after Owlbear's next reload either.
      letGo();
      mark(false);
    }
  }, 1000);

  const send = (message: TabMessage) => linked?.source.postMessage(message, origin);

  const run = async (path: string, args: unknown[]): Promise<unknown> => {
    const own = linked!;
    if (path === "scene.items.updatePatched" || path === "scene.local.updatePatched") {
      const patches = args[0] as ItemPatch[];
      const api = path.startsWith("scene.local") ? OBR.scene.local : OBR.scene.items;
      await api.updateItems(
        patches.map((patch) => patch.id),
        (drafts) => drafts.forEach((draft) => applyPatch(draft, patches.find((patch) => patch.id === draft.id)!))
      );
      return undefined;
    }
    if (path === "interaction.startPatched") {
      const handle = ++handles;
      own.interactions.set(handle, OBR.interaction.startItemInteraction(args[0] as Item | Item[]));
      return handle;
    }
    if (path === "interaction.updatePatched") {
      const [update] = await own.interactions.get(args[0] as number)!;
      const patches = args[1] as ItemPatch[];
      update((draft) => (Array.isArray(draft) ? draft : [draft]).forEach((item, i) => applyPatch(item, patches[i])));
      return undefined;
    }
    if (path === "interaction.stopPatched") {
      const interaction = own.interactions.get(args[0] as number);
      own.interactions.delete(args[0] as number);
      (await interaction)?.[1]();
      return undefined;
    }
    // Any other: the SDK's own, by its path; callbacks made here, calling the tab's.
    const parts = path.split(".");
    let owner: unknown = OBR;
    for (const part of parts.slice(0, -1)) {
      owner = (owner as Record<string, unknown>)[part];
    }
    const fn = (owner as Record<string, unknown>)[parts[parts.length - 1]];
    if (typeof fn !== "function") {
      throw new Error(`no such call: ${path}`);
    }
    const marks: number[] = [];
    const real = args.map((arg) => {
      const mark = arg as FnMark | null;
      if (mark && typeof mark === "object" && typeof mark.rrFn === "number") {
        marks.push(mark.rrFn);
        return (...callArgs: unknown[]) => {
          if (linked === own) {
            send({ rrTab: "event", session: own.session, fn: mark.rrFn, args: callArgs });
          }
        };
      }
      return arg;
    });
    const value = await (fn as (...a: unknown[]) => unknown).apply(owner, real);
    if (typeof value === "function") {
      // A subscription's ending: kept here, called when the tab drops it (or goes); now, if that's
      // happened meanwhile.
      if (linked !== own || marks.some((mark) => own.dropped.delete(mark))) {
        (value as () => void)();
        return undefined;
      }
      for (const mark of marks) {
        own.subs.set(mark, value as () => void);
      }
      return undefined;
    }
    return value;
  };

  window.addEventListener("message", (event) => {
    const data = event.data as TabMessage | null;
    if (event.origin !== origin || !data?.rrTab || !event.source) {
      return;
    }
    if (data.rrTab === "find") {
      if (linked && linked.session !== data.session && data.since < linked.since && Date.now() - linked.heard < QUIET_MS) {
        // An older tab, while a newer one's linked: told so (it stops looking).
        (event.source as Window).postMessage({ rrTab: "taken", session: data.session } satisfies TabMessage, origin);
        return;
      }
      let fresh = false;
      if (linked?.session !== data.session) {
        fresh = true;
        letGo();
        linked = { session: data.session, since: data.since, source: event.source as Window, heard: Date.now(), subs: new Map(), interactions: new Map(), dropped: new Set() };
        onLinked(true);
        mark(true);
      }
      linked.heard = Date.now();
      const answer = (ready: boolean) => send({ rrTab: "found", session: data.session, playerId: OBR.player.id, ready, fresh });
      OBR.scene.isReady().then(answer, () => answer(false));
      return;
    }
    if (!linked || data.session !== linked.session) {
      return;
    }
    linked.heard = Date.now();
    if (data.rrTab === "beat") {
      send({ rrTab: "beat", session: linked.session });
    } else if (data.rrTab === "bye") {
      // Closed (or its frame loading again: linked again in a moment, marked again then).
      letGo();
      mark(false);
    } else if (data.rrTab === "drop") {
      const end = linked.subs.get(data.fn);
      if (end) {
        end();
        linked.subs.delete(data.fn);
      } else {
        linked.dropped.add(data.fn);
      }
    } else if (data.rrTab === "call") {
      const { id, session } = data;
      run(data.path, data.args).then(
        (value) => send({ rrTab: "result", session, id, value }),
        (error) => send({ rrTab: "result", session, id, error: String(error?.message ?? error) })
      );
    }
  });
}
