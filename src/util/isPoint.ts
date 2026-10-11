import type { Vector2 } from "@owlbear-rodeo/sdk";
import { isPlainObject } from "./isPlainObject";

/** A point read from metadata: both coordinates finite numbers. */
export function isPoint(value: unknown): value is Vector2 {
  return isPlainObject(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
}
