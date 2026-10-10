import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// nms_logo.svg lives in the repo root (shipped with the package). Terminals cannot draw SVG,
// so the single path is parsed, flattened, and rasterized into Unicode half-block art.
export const LOGO_SVG = fileURLToPath(new URL('../nms_logo.svg', import.meta.url));

const TOKEN = /[MLHVQZ]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi;
const CURVE_STEPS = 8;

// SVG path data (M, L, H, V, Q, Z; absolute) -> list of polygon rings.
export function parsePath(d) {
  const tokens = d.match(TOKEN) ?? [];
  const rings = [];
  let ring = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = null;
  let i = 0;
  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    switch (cmd) {
      case 'M':
        x = num();
        y = num();
        sx = x;
        sy = y;
        ring = [[x, y]];
        rings.push(ring);
        cmd = 'L'; // implicit lineto after moveto
        break;
      case 'L':
        x = num();
        y = num();
        ring.push([x, y]);
        break;
      case 'H':
        x = num();
        ring.push([x, y]);
        break;
      case 'V':
        y = num();
        ring.push([x, y]);
        break;
      case 'Q': {
        const cx = num();
        const cy = num();
        const ex = num();
        const ey = num();
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const u = s / CURVE_STEPS;
          ring.push([
            (1 - u) ** 2 * x + 2 * (1 - u) * u * cx + u * u * ex,
            (1 - u) ** 2 * y + 2 * (1 - u) * u * cy + u * u * ey,
          ]);
        }
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        x = sx;
        y = sy;
        cmd = null;
        break;
      default:
        i++; // unsupported token; skip it
    }
  }
  return rings;
}

// Even-odd point-in-polygon across all rings, so counters (holes in glyphs) stay empty.
function inside(rings, px, py) {
  let hit = false;
  for (const ring of rings) {
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a];
      const [xb, yb] = ring[b];
      if ((ya > py) !== (yb > py) && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) hit = !hit;
    }
  }
  return hit;
}

// Sample a pixel grid of `cols` columns; rows follow the glyph aspect ratio.
export function rasterize(rings, cols) {
  const pts = rings.flat();
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const rows = Math.max(1, Math.round((cols * (maxY - minY)) / (maxX - minX)));
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      const px = minX + ((c + 0.5) / cols) * (maxX - minX);
      const py = minY + ((r + 0.5) / rows) * (maxY - minY);
      line.push(inside(rings, px, py));
    }
    grid.push(line);
  }
  return grid;
}

// Two pixel rows per text row: ▀ ▄ █ keep pixels roughly square in a 1:2 cell.
export function halfBlocks(grid) {
  const lines = [];
  for (let r = 0; r < grid.length; r += 2) {
    let line = '';
    for (let c = 0; c < grid[r].length; c++) {
      const top = grid[r][c];
      const bottom = grid[r + 1]?.[c] ?? false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const cache = new Map();

// Logo as text lines of `cols` width, or null if the SVG is missing or unreadable.
export function logoLines(cols = 52, file = LOGO_SVG) {
  const key = `${file}:${cols}`;
  if (cache.has(key)) return cache.get(key);
  let lines = null;
  try {
    const svg = readFileSync(file, 'utf8');
    const d = svg.match(/<path[^>]*\sd="([^"]+)"/)?.[1];
    if (d) lines = halfBlocks(rasterize(parsePath(d), cols));
  } catch {
    lines = null;
  }
  cache.set(key, lines);
  return lines;
}
