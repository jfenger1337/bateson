// Shared by the hook launchers (hooks/*.mjs), which are what Claude Code runs: each checks that this Node runs
// TypeScript (lib/node-check.mjs says why that needs a .mjs file), then imports the hook of the same name.
//
// On a Node that cannot, the hook exits 1 with the reason on stderr: Claude Code shows that to the person as a
// hook error, and the session carries on. Never exit 2, which would hand the text to the agent instead. The
// reason also goes to ~/.bateson/hooks.log, as any hook error does (hooks/_io.ts), so Settings shows it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needTypeScript } from '../lib/node-check.mjs';

/** Exit unless this Node can run hook `name` (catchup, nudge, remind or rewake). */
export function hookNeedsTypeScript(name) {
  if (process.features && process.features.typescript) return;
  // Other tools run the hooks they find in Claude Code's settings. These are for Claude Code alone, so elsewhere
  // they do nothing, as hooks/_io.ts does.
  if (process.env.CLAUDECODE !== '1') process.exit(0);
  const install = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install.mjs');
  needTypeScript(`run \`node ${install}\` with it, so the hooks use that Node`, (text) => {
    try {
      const root = process.env.BATESON_HOME || path.join(os.homedir(), '.bateson');
      fs.mkdirSync(root, { recursive: true });
      fs.appendFileSync(path.join(root, 'hooks.log'), `${new Date().toISOString()} ${name}.ts ${text.split('\n').join(' | ')}\n`);
    } catch { /* nowhere to write: stderr has it */ }
  });
}
