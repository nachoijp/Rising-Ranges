// A stopwatch for the console, off unless asked for: in the extension's
// frame (DevTools → the console's context menu → this extension's page),
//   localStorage.setItem("rising-ranges/timing", "1")
// and the page loaded again (removeItem to turn it off). On, each stage's
// times are added up over a few seconds and shown as a table, the costliest
// first (served locally, kept in dev-tests/tmp/timing.log too). Off, a stage
// costs a check.

const KEY = "rising-ranges/timing";
const WINDOW_MS = 3000;

export const timingOn = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

type Stat = { n: number; total: number; max: number };
const stats = new Map<string, Stat>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  flushTimer = undefined;
  const rows = [...stats].sort((a, b) => b[1].total - a[1].total);
  stats.clear();
  // Only frames drawn, and quickly (an idle view animating its weather): nothing to tell.
  if (rows.every(([label, s]) => label === "3d.render" && s.max < 8)) {
    return;
  }
  // Plain text in columns: it copies as it's seen (a console table doesn't).
  const ms = (v: number) => v.toFixed(1).padStart(9);
  const width = Math.max(5, ...rows.map(([label]) => label.length));
  const lines = rows.map(([label, s]) => `${label.padEnd(width)} ${String(s.n).padStart(5)}${ms(s.total)}${ms(s.total / s.n)}${ms(s.max)}`);
  const head = `${"stage".padEnd(width)} ${"n".padStart(5)}${"total".padStart(9)}${"avg".padStart(9)}${"max".padStart(9)}`;
  const page = `${location.pathname.replace(/^.*\//, "") || "page"}${location.search.includes("full") ? " full" : ""}`;
  const text = `[Rising Ranges] times, ms (${page})\n${head}\n${lines.join("\n")}`;
  console.log(text);
  // Served locally: to the dev server's log too (see vite.config.js).
  if (import.meta.env.DEV) {
    void fetch("/__timing", { method: "POST", body: text }).catch(() => {});
  }
}

/** A stage's time, added to its label's. */
export function record(label: string, ms: number) {
  const s = stats.get(label) ?? { n: 0, total: 0, max: 0 };
  s.n += 1;
  s.total += ms;
  s.max = Math.max(s.max, ms);
  stats.set(label, s);
  // In windows of a few seconds from the first (a view that draws every frame never goes quiet).
  flushTimer ??= setTimeout(flush, WINDOW_MS);
}

/** `f`, timed as `label` (only while the stopwatch is on). */
export function time<T>(label: string, f: () => T): T {
  if (!timingOn) {
    return f();
  }
  const t0 = performance.now();
  try {
    return f();
  } finally {
    record(label, performance.now() - t0);
  }
}

/** A time to measure from (0 while the stopwatch is off), for `since`. */
export const stamp = () => (timingOn ? performance.now() : 0);

/** The time since a `stamp`, as `label`. */
export function since(label: string, t0: number) {
  if (timingOn) {
    record(label, performance.now() - t0);
  }
}
