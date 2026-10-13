// Owlbear builds a popover, context-menu embed or modal from scratch every
// time it opens, so the first time each panel opens it downloads its scripts,
// styles and fonts (a dozen files) — what makes it feel slow. Their names are
// hashed and kept for a week (see the hosting's cache headers), and this
// page shares the browser's cache with them (same origin, same room), so
// fetching them here once, a while after the room has loaded, means every
// panel opens from the cache.
//
// What each page needs is read from the page itself (its script and
// modulepreload tags), and the fonts from its stylesheets: only the latin
// ones, the subset the panels' text uses.

const PAGES = ["/settings.html", "/distances.html", "/token-height.html", "/theme.html"];
/** After the room's own loading, so it doesn't compete with it. */
const DELAY_MS = 4000;
/** A few at a time, like a page would. */
const PARALLEL = 4;

const ASSET_REF = /(?:src|href)="([^"]*\/assets\/[^"]+\.(?:js|css))"/g;
const LATIN_FONT = /url\(([^)]*\/assets\/roboto-latin-\d+-normal-[^)]+\.woff2)\)/g;

async function text(url: string): Promise<string> {
  const response = await fetch(url, { priority: "low" } as RequestInit);
  return response.ok ? response.text() : "";
}

async function fetchAll(urls: string[]) {
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      // Only to have it cached; a failed one just loads when its panel opens.
      await fetch(url, { priority: "low" } as RequestInit).then((response) => response.arrayBuffer()).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

async function prefetch() {
  const pages = await Promise.all(PAGES.map((page) => text(page).catch(() => "")));
  const assets = new Set(pages.flatMap((html) => [...html.matchAll(ASSET_REF)].map((match) => match[1])));
  const styles = [...assets].filter((url) => url.endsWith(".css"));
  const scripts = [...assets].filter((url) => !url.endsWith(".css"));
  // Stylesheets first: they're fetched for their fonts anyway.
  const css = await Promise.all(styles.map((url) => text(url).catch(() => "")));
  const fonts = new Set(css.flatMap((sheet) => [...sheet.matchAll(LATIN_FONT)].map((match) => match[1])));
  await fetchAll([...scripts, ...fonts]);
}

/** Warms the browser's cache for every panel, once, a while after the room loads. */
export function prefetchPanels() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) {
    return;
  }
  setTimeout(() => {
    prefetch().catch(() => {});
  }, DELAY_MS);
}
