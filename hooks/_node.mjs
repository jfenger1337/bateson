// Shared by the hook launchers (hooks/*.mjs), which are what Claude Code runs. Each runs the hook of the same name.
//
// `npm run build` bundles each hook into plain JavaScript (scripts/build-hooks.ts), which starts several times
// faster than the TypeScript it comes from: Claude Code waits for a hook after every Edit, Write and Bash call.
// The bundle runs while it is newer than every file that went into it (lib/bundle.mjs); otherwise (sources changed
// since the build, or no build) the hook runs from source.
//
// Either way it first checks that this Node runs TypeScript (lib/node-check.mjs says why that needs a .mjs file):
// a bundle would run without, but the bateson command and the server would not, and the hook is where the
// person hears why. On a Node that cannot, the hook exits 1 with the reason on stderr: Claude Code shows that to the person as a
// hook error, and the session carries on. Never exit 2, which would hand the text to the agent instead. The
// reason also goes to ~/.bateson/hooks.log, as any hook error does (hooks/_io.ts), so Settings shows it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentBundle } from '../lib/bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
// Where a launcher leaves what it read from stdin, for hooks/_io.ts: stdin can be read only once.
const INPUT = Symbol.for('bateson.hookInput');

/** The hook's input, as Claude Code sent it on stdin; read once, and kept for the hook itself. */
export function readInput() {
  if (typeof globalThis[INPUT] !== 'string') {
    try { globalThis[INPUT] = fs.readFileSync(0, 'utf8'); } catch (e) { globalThis[INPUT] = ''; }
  }
  return globalThis[INPUT];
}

/** Run hook `name` (catchup, nudge, remind or rewake): its bundle if it is current, else its source. */
export async function runHook(name) {
  await hookNeedsTypeScript(name);
  // A hook that cannot load (its files rewritten under it by an update, one missing) does nothing, quietly: the
  // error goes to hooks.log, where Settings shows it, and not to the person as a stack trace after every tool call.
  try {
    const built = currentBundle(path.join(HERE, 'dist'), name);
    await import(built ? pathToFileURL(built).href : `./${name}.ts`);
  } catch (e) {
    logHook(name, `could not load: ${e && e.stack ? e.stack : e}`);
    process.exit(0);
  }
}

function logHook(name, text) {
  try {
    const root = process.env.BATESON_HOME || path.join(os.homedir(), '.bateson');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(root, 'hooks.log'), `${new Date().toISOString()} ${name}.ts ${String(text).split('\n').join(' | ')}\n`);
  } catch (e) { /* nowhere to write */ }
}

/** Exit unless this Node runs TypeScript. */
async function hookNeedsTypeScript(name) {
  if (process.features && process.features.typescript) return;
  // Other tools run the hooks they find in Claude Code's settings. These are for Claude Code alone, so elsewhere
  // they do nothing, as hooks/_io.ts does.
  if (process.env.CLAUDECODE !== '1') process.exit(0);
  const { needTypeScript } = await import('../lib/node-check.mjs');
  const install = path.join(REPO, 'scripts', 'install.mjs');
  needTypeScript(`run \`node ${install}\` with it, so the hooks use that Node`, (text) => logHook(name, text));
}
