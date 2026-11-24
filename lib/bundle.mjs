// Whether a bundle `npm run build` made (scripts/build-hooks.ts) is still the code as it is now. The hooks and the
// bateson command are TypeScript, which Node strips the types from every time it starts one: about 100 ms more than
// the work itself, and more on Windows. A bundle is plain JavaScript in one file and needs none of that. It runs
// only while it is newer than every file that went into it, listed beside it in inputs.json; after an edit without
// a build, the source runs as before. Plain JavaScript any Node reads, and nothing imported but fs and path, since
// every hook loads this first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `dist`/<name>.js, if it was built from the files as they are now; else null. */
export function currentBundle(dist, name) {
  const file = path.join(dist, `${name}.js`);
  try {
    const { built, bundles } = JSON.parse(fs.readFileSync(path.join(dist, 'inputs.json'), 'utf8'));
    const inputs = bundles && bundles[name];
    if (typeof built !== 'number' || !Array.isArray(inputs) || !inputs.length || !fs.existsSync(file)) return null;
    for (const rel of inputs) if (fs.statSync(path.join(REPO, rel)).mtimeMs > built) return null;
    return file;
  } catch (e) { return null; }
}
