import { Command, type PathCommand } from "@owlbear-rodeo/sdk";

// An SVG drawing's outlines (every <path> in it) as an Owlbear Path's
// commands, fitted into a box: so an icon drawn in Inkscape can be a
// Path item (an Image item needs its picture served where Owlbear can load
// it). Each path's own data: moves, lines, curves (arcs as cubics), closes.

type Pt = [number, number];

/** The outlines of `svg`, fitted (keeping their shape) into a `width` × `height` box from (0, 0), centred. */
export function svgCommands(svg: string, width: number, height: number): PathCommand[] {
  const commands = [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].flatMap((match) => pathCommands(match[1]));
  // Fitted by what's drawn (the page and any group's move left out).
  const xs: number[] = [];
  const ys: number[] = [];
  for (const command of commands) {
    for (let i = 1; i < command.length; i += 2) {
      xs.push(command[i] as number);
      ys.push(command[i + 1] as number);
    }
  }
  if (xs.length === 0) {
    return [];
  }
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const k = Math.min(width / (x1 - x0 || 1), height / (y1 - y0 || 1));
  const [dx, dy] = [(width - (x1 - x0) * k) / 2 - x0 * k, (height - (y1 - y0) * k) / 2 - y0 * k];
  return commands.map((command) => command.map((v, i) => (i === 0 ? v : i % 2 === 1 ? (v as number) * k + dx : (v as number) * k + dy)) as PathCommand);
}

/** One path's data as commands (absolute; arcs as cubic curves). */
function pathCommands(d: string): PathCommand[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: PathCommand[] = [];
  let at: Pt = [0, 0];
  let start: Pt = [0, 0];
  let op = "";
  let i = 0;
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/[a-zA-Z]/.test(tokens[i]);
  while (i < tokens.length) {
    if (!isNum()) {
      op = tokens[i++];
    }
    const rel = op === op.toLowerCase();
    const from = (x: number, y: number): Pt => (rel ? [at[0] + x, at[1] + y] : [x, y]);
    switch (op.toLowerCase()) {
      case "m": {
        at = from(num(), num());
        start = at;
        out.push([Command.MOVE, ...at]);
        // More pairs after a move are lines.
        op = rel ? "l" : "L";
        break;
      }
      case "l":
        at = from(num(), num());
        out.push([Command.LINE, ...at]);
        break;
      case "h":
        at = [rel ? at[0] + num() : num(), at[1]];
        out.push([Command.LINE, ...at]);
        break;
      case "v":
        at = [at[0], rel ? at[1] + num() : num()];
        out.push([Command.LINE, ...at]);
        break;
      case "c": {
        const a = from(num(), num());
        const b = from(num(), num());
        at = from(num(), num());
        out.push([Command.CUBIC, ...a, ...b, ...at]);
        break;
      }
      case "q": {
        const a = from(num(), num());
        at = from(num(), num());
        out.push([Command.QUAD, ...a, ...at]);
        break;
      }
      case "a": {
        const [rx, ry, turn, large, sweep] = [num(), num(), num(), num(), num()];
        const to = from(num(), num());
        out.push(...arcCubics(at, to, rx, ry, turn, !!large, !!sweep));
        at = to;
        break;
      }
      case "z":
        out.push([Command.CLOSE]);
        at = start;
        break;
      default:
        // Anything else (smooth curves): its numbers skipped.
        while (isNum()) {
          i++;
        }
    }
  }
  return out;
}

/** An SVG arc (from `p` to `q`) as cubic curves, a quarter turn or less each. */
function arcCubics(p: Pt, q: Pt, rx: number, ry: number, turnDeg: number, large: boolean, sweep: boolean): PathCommand[] {
  if (rx === 0 || ry === 0) {
    return [[Command.LINE, ...q]];
  }
  const phi = (turnDeg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const [dx, dy] = [(p[0] - q[0]) / 2, (p[1] - q[1]) / 2];
  const [x1, y1] = [cos * dx + sin * dy, -sin * dx + cos * dy];
  let [a, b] = [Math.abs(rx), Math.abs(ry)];
  const lambda = (x1 * x1) / (a * a) + (y1 * y1) / (b * b);
  if (lambda > 1) {
    [a, b] = [a * Math.sqrt(lambda), b * Math.sqrt(lambda)];
  }
  const sign = large === sweep ? -1 : 1;
  const root = Math.sqrt(Math.max(0, (a * a * b * b - a * a * y1 * y1 - b * b * x1 * x1) / (a * a * y1 * y1 + b * b * x1 * x1)));
  const [cx1, cy1] = [(sign * root * a * y1) / b, (-sign * root * b * x1) / a];
  const [cx, cy] = [cos * cx1 - sin * cy1 + (p[0] + q[0]) / 2, sin * cx1 + cos * cy1 + (p[1] + q[1]) / 2];
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = angle(1, 0, (x1 - cx1) / a, (y1 - cy1) / b);
  let span = angle((x1 - cx1) / a, (y1 - cy1) / b, (-x1 - cx1) / a, (-y1 - cy1) / b);
  if (!sweep && span > 0) {
    span -= Math.PI * 2;
  } else if (sweep && span < 0) {
    span += Math.PI * 2;
  }
  const parts = Math.ceil(Math.abs(span) / (Math.PI / 2));
  const step = span / parts;
  const h = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): Pt => [cx + a * Math.cos(t) * cos - b * Math.sin(t) * sin, cy + a * Math.cos(t) * sin + b * Math.sin(t) * cos];
  const tangent = (t: number): Pt => [-a * Math.sin(t) * cos - b * Math.cos(t) * sin, -a * Math.sin(t) * sin + b * Math.cos(t) * cos];
  const out: PathCommand[] = [];
  for (let n = 0; n < parts; n++) {
    const [s, e] = [t0 + n * step, t0 + (n + 1) * step];
    const [ps, pe, ts, te] = [point(s), point(e), tangent(s), tangent(e)];
    out.push([Command.CUBIC, ps[0] + h * ts[0], ps[1] + h * ts[1], pe[0] - h * te[0], pe[1] - h * te[1], ...(n === parts - 1 ? q : pe)]);
  }
  return out;
}
