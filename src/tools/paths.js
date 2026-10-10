import path from 'node:path';

// Directories skipped by search and walk operations.
export const IGNORED_DIRS = new Set(['node_modules', '.git', '.nemesis']);

// roots: a workspace root string or an array of allowed roots (first is the base for relative paths).
// Resolve a model-supplied path and refuse anything outside every root.
export function resolveInWorkspace(roots, p) {
  if (typeof p !== 'string' || p.length === 0) throw new Error('path must be a non-empty string');
  const list = Array.isArray(roots) ? roots : [roots];
  const abs = path.resolve(list[0], p);
  const inside = list.some((root) => {
    const rel = path.relative(root, abs);
    return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  });
  if (!inside) throw new Error(`path is outside the workspace: ${p}`);
  return abs;
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}
