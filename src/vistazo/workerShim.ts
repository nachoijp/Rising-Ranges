// In the terrain's worker (see terrainWorker): the Owlbear SDK, which some shared modules bring in for
// their plain helpers, reads `window` as it loads. A worker has none: its own global stands in (it has
// a location and message events; the SDK only listens for Owlbear's own messages, which never come).
// Imported first, before anything that brings the SDK in.
(globalThis as { window?: unknown }).window ??= globalThis;
