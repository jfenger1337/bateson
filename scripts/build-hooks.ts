// Part of `npm run build`: each hook (hooks/<name>.ts) bundled into one plain JavaScript file, hooks/dist/<name>.js.
//
// Claude Code starts a hook as a new Node process after every Edit, Write and Bash call, and the agent waits for
// it. Run from source, each one first strips the types from a dozen TypeScript files, which costs about 100 ms
// more than the work itself; more on Windows, where starting a process and opening each file is slower. A
// bundle needs neither. hooks/_node.mjs runs the bundle only while it is newer than every file that went into it,
// listed in hooks/dist/inputs.json; after an edit without a build, the hook runs from source as before.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { Plugin } from 'vite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(REPO, 'hooks');
const OUT = path.join(HOOKS, 'dist');
const NAMES = ['catchup', 'nudge', 'remind', 'rewake'];

// Before the sources are read: a file saved during the build counts as newer than the bundle.
const built = Date.now();
fs.rmSync(OUT, { recursive: true, force: true });
const inputs: Record<string, string[]> = {};

for (const name of NAMES) {
  const files: string[] = [];
  // A module that finds files next to itself (lib/claude-settings.ts finds hooks/, lib/update.ts the repository)
  // does it from import.meta.url, which in the bundle would be hooks/dist/<name>.js. It is given its own place.
  const ownPlace: Plugin = {
    name: 'own-place',
    transform(code, id) {
      if (!code.includes('import.meta.url')) return null;
      const rel = path.relative(OUT, id).split(path.sep).join('/');
      return { code: code.replaceAll('import.meta.url', `new URL(${JSON.stringify(rel)}, import.meta.url).href`), map: null };
    },
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') files.push(...chunk.moduleIds);
    },
  };
  await build({
    configFile: false,
    root: REPO,
    publicDir: false,
    logLevel: 'warn',
    plugins: [ownPlace],
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: path.join(HOOKS, `${name}.ts`),
      outDir: OUT,
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      sourcemap: false,
      rollupOptions: { output: { format: 'es', entryFileNames: `${name}.js` } },
    },
  });
  inputs[name] = files.filter((f) => path.isAbsolute(f) && fs.existsSync(f)).map((f) => path.relative(REPO, f).split(path.sep).join('/')).sort();
}

fs.writeFileSync(path.join(OUT, 'inputs.json'), JSON.stringify({ built, hooks: inputs }, null, 2) + '\n');
console.log(`hooks bundled in ${path.relative(process.cwd(), OUT) || '.'}`);
