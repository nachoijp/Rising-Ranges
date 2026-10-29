import type { Group, ReliefData, Shape } from "../types";
import type { ReliefEditor } from "./editor";

// Groups of shapes, the editor's own (the Vistazo and what's measured go by
// the shapes' order alone): folders in the shapes' list, in one another as
// deep as wanted. A group's shapes, and its groups', are always together in
// that order, as a block, so the order inside it stays as it is (see
// tidyGroups); it's moved, hidden or locked whole.

const newId = () => Math.random().toString(36).slice(2, 8);

/** A relief's groups (none, if it has none). */
export const groupsOf = (data: Pick<ReliefData, "groups">): Group[] => data.groups ?? [];

/** A group and those in it, all the way down (ids). */
export function subtree(data: ReliefData, id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of groupsOf(data)) {
      if (g.parent && ids.has(g.parent) && !ids.has(g.id)) {
        ids.add(g.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** The shapes in a group or in one in it (indexes, the lowest first). */
export function membersOf(data: ReliefData, id: string): number[] {
  const ids = subtree(data, id);
  return data.shapes.flatMap((s, i) => (s.group && ids.has(s.group) ? [i] : []));
}

/** The groups something in `id` is in: that one, then the one it's in, and so on up. */
export function ancestors(data: ReliefData, id: string | undefined): string[] {
  const byId = new Map(groupsOf(data).map((g) => [g.id, g]));
  const out: string[] = [];
  for (let at = id; at && byId.has(at) && !out.includes(at); at = byId.get(at)!.parent) {
    out.push(at);
  }
  return out;
}

/** The group of the shape picked, if any (where a new one goes). */
export function pickedGroup(ed: ReliefEditor): string | undefined {
  return ed.sel?.kind === "shape" ? ed.data.shapes[ed.sel.i]?.group : undefined;
}

/**
 * The groups as they must be, after any change: none left with no shape in
 * it (what's in one that goes, in the one it was in); none in one that
 * isn't there; and each group's shapes together, as a block where its
 * lowest one is, the shapes and groups in it in their order (what's picked
 * follows them). Whether the shapes moved.
 */
export function tidyGroups(ed: ReliefEditor): boolean {
  const data = ed.data;
  if (!data.groups?.length && !data.shapes.some((s) => s.group)) {
    data.groups = undefined;
    return false;
  }
  const groups = groupsOf(data);
  const ids = new Set(groups.map((g) => g.id));
  for (const g of groups) {
    if (g.parent && !ids.has(g.parent)) {
      g.parent = undefined;
    }
  }
  for (const s of data.shapes) {
    if (s.group && !ids.has(s.group)) {
      s.group = undefined;
    }
  }
  // Empty ones out, from the deepest up (one may empty the one it's in).
  for (let gone = true; gone; ) {
    gone = false;
    for (const g of [...groups]) {
      if (membersOf(data, g.id).length === 0) {
        for (const other of groups) {
          if (other.parent === g.id) {
            other.parent = g.parent;
          }
        }
        groups.splice(groups.indexOf(g), 1);
        gone = true;
      }
    }
  }
  data.groups = groups.length > 0 ? groups : undefined;
  // Each container's own (its shapes and its groups) by where their lowest is, a group's spelled out.
  const lowest = new Map<string, number>();
  data.shapes.forEach((s, i) => {
    for (const id of ancestors(data, s.group)) {
      lowest.set(id, Math.min(lowest.get(id) ?? Infinity, i));
    }
  });
  const order: number[] = [];
  const spell = (container: string | undefined) => {
    const items: { at: number; shape?: number; group?: string }[] = [
      ...data.shapes.flatMap((s, i) => ((s.group ?? undefined) === container ? [{ at: i, shape: i }] : [])),
      ...groups.filter((g) => g.parent === container).map((g) => ({ at: lowest.get(g.id) ?? Infinity, group: g.id })),
    ];
    items.sort((a, b) => a.at - b.at);
    for (const item of items) {
      if (item.shape !== undefined) {
        order.push(item.shape);
      } else {
        spell(item.group);
      }
    }
  };
  spell(undefined);
  if (order.every((i, k) => i === k)) {
    return false;
  }
  reorder(ed, order.map((i) => data.shapes[i]));
  return true;
}

/** The shapes in this order instead (the same ones); what's picked, and a picture being taken for one, follow them. */
function reorder(ed: ReliefEditor, shapes: Shape[]) {
  const data = ed.data;
  const at = (i: number) => shapes.indexOf(data.shapes[i]);
  const sel = ed.sel;
  if (sel?.kind === "shape") {
    ed.sel = { kind: "shape", i: at(sel.i), ...(sel.more ? { more: sel.more.map(at) } : {}) };
  }
  if (ed.skinPick !== null) {
    ed.skinPick = at(ed.skinPick);
  }
  data.shapes = shapes;
}

/** The shapes picked (indexes). */
function picked(ed: ReliefEditor): number[] {
  return ed.sel?.kind === "shape" ? [ed.sel.i, ...(ed.sel.more ?? [])] : [];
}

/**
 * The shapes picked made a group, in the group they all share (the
 * innermost), together where the topmost of them was. A group in that one
 * all of whose shapes are picked goes in whole. False with none picked.
 */
export function groupPicked(ed: ReliefEditor): boolean {
  const data = ed.data;
  const list = picked(ed);
  if (list.length === 0) {
    return false;
  }
  ed.pushUndo();
  const chains = list.map((i) => ancestors(data, data.shapes[i].group));
  const shared = chains[0].find((id) => chains.every((chain) => chain.includes(id)));
  const group: Group = { id: newId(), name: "", parent: shared };
  data.groups = [...groupsOf(data), group];
  const all = new Set(list);
  list.forEach((i, k) => {
    // From the one just inside the shared group down: the first all picked goes in whole.
    const below = chains[k].slice(0, shared ? chains[k].indexOf(shared) : chains[k].length).reverse();
    const whole = below.find((id) => membersOf(data, id).every((m) => all.has(m)));
    const g = whole && groupsOf(data).find((x) => x.id === whole);
    if (g) {
      g.parent = group.id;
    } else {
      data.shapes[i].group = group.id;
    }
  });
  // Together where the topmost was (what was under it there stays under it).
  const members = new Set(membersOf(data, group.id));
  const top = Math.max(...members);
  const others = data.shapes.filter((_, i) => !members.has(i));
  const at = data.shapes.slice(0, top).filter((_, i) => !members.has(i)).length;
  reorder(ed, [...others.slice(0, at), ...data.shapes.filter((_, i) => members.has(i)), ...others.slice(at)]);
  tidyGroups(ed);
  return true;
}

/** A group undone: what was in it, in the one it was in, where it is. */
export function ungroup(ed: ReliefEditor, id: string) {
  const data = ed.data;
  const g = groupsOf(data).find((x) => x.id === id);
  if (!g) {
    return;
  }
  ed.pushUndo();
  for (const s of data.shapes) {
    if (s.group === id) {
      s.group = g.parent;
    }
  }
  for (const other of groupsOf(data)) {
    if (other.parent === id) {
      other.parent = g.parent;
    }
  }
  data.groups = groupsOf(data).filter((x) => x !== g);
  tidyGroups(ed);
}

/** A group's shapes picked (those that can be: not hidden nor locked); with `add`, with those already. */
export function pickGroup(ed: ReliefEditor, id: string, add = false) {
  const free = membersOf(ed.data, id).filter((i) => !ed.data.shapes[i].hidden && !ed.data.shapes[i].locked);
  const list = [...new Set([...(add ? picked(ed) : []), ...free.reverse()])];
  ed.sel = list.length > 0 ? { kind: "shape", i: list[0], ...(list.length > 1 ? { more: list.slice(1) } : {}) } : null;
}

/** A group's shapes all hidden (or locked), or all not if they all were. */
export function toggleGroup(ed: ReliefEditor, id: string, what: "hidden" | "locked") {
  const shapes = membersOf(ed.data, id).map((i) => ed.data.shapes[i]);
  const set = !shapes.every((s) => s[what]);
  ed.pushUndo();
  for (const s of shapes) {
    s[what] = set || undefined;
  }
  if (set && picked(ed).some((i) => shapes.includes(ed.data.shapes[i]))) {
    ed.sel = null;
  }
}

/** Something in the list: a shape (its index) or a group (its id). */
export type ListItem = { shape: number } | { group: string };

/** Where in the list something's let go: over or under a shape's row or a group's, or in a group (at its top). */
export type ListDrop = { side: "above" | "below"; shape: number } | { side: "above" | "below" | "into"; group: string };

/**
 * Something moved in the list (a shape, or a group with all in it) to
 * where it's let go: in the group of the row it's by (`into`: that group,
 * at its top). False if it can't go there (a group into itself).
 */
export function moveItem(ed: ReliefEditor, item: ListItem, drop: ListDrop): boolean {
  const data = ed.data;
  const block = "shape" in item ? [item.shape] : membersOf(data, item.group);
  const inside = "group" in item ? subtree(data, item.group) : new Set<string>();
  if (block.length === 0 || ("shape" in drop ? block.includes(drop.shape) : inside.has(drop.group))) {
    return false;
  }
  const target = "group" in drop ? groupsOf(data).find((g) => g.id === drop.group) : undefined;
  if ("group" in drop && !target) {
    return false;
  }
  // The group's own, but not what's moving (it may be in it): what it's put by.
  const targetMembers = target ? membersOf(data, target.id).filter((i) => !block.includes(i)) : [];
  // Over a row: just above its shape (or its group's topmost); under: just below it (or its group's lowest).
  const [anchor, after] =
    "shape" in drop ? [data.shapes[drop.shape], drop.side === "above"] : drop.side === "below" ? [data.shapes[targetMembers[0]], false] : [data.shapes[targetMembers[targetMembers.length - 1]], true];
  const parent = "shape" in drop ? data.shapes[drop.shape].group : drop.side === "into" ? target!.id : target!.parent;
  ed.pushUndo();
  const moving = block.map((i) => data.shapes[i]);
  // Nothing else in that group to put it by: it stays where it is in the list.
  if (anchor) {
    const rest = data.shapes.filter((s) => !moving.includes(s));
    const at = rest.indexOf(anchor) + (after ? 1 : 0);
    reorder(ed, [...rest.slice(0, at), ...moving, ...rest.slice(at)]);
  }
  if ("shape" in item) {
    moving[0].group = parent;
  } else {
    groupsOf(data).find((g) => g.id === item.group)!.parent = parent;
  }
  tidyGroups(ed);
  return true;
}

/** Groups with no name: one, "Grupo n" (`label`), one past the highest so named. */
export function nameGroups(data: ReliefData, label: (n: number) => string) {
  const [pre, post] = label(987654321).split("987654321");
  let highest = 0;
  for (const g of groupsOf(data)) {
    const n = g.name.startsWith(pre) && g.name.endsWith(post) ? Number(g.name.slice(pre.length, g.name.length - post.length)) : NaN;
    if (Number.isInteger(n)) {
      highest = Math.max(highest, n);
    }
  }
  for (const g of groupsOf(data)) {
    if (!g.name) {
      g.name = label(++highest);
    }
  }
}
