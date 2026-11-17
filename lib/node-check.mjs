// Whether this Node can run bateson, asked before anything loads a .ts file. bateson is TypeScript, which Node runs as
// it is only from 22.18 on: an older Node stops at the extension ("Unknown file extension .ts") before a line of it
// runs, so no check inside a .ts file could ever speak. This file and the launchers that import it (cli/bateson.mjs,
// scripts/install.mjs) are plain JavaScript, kept to syntax any Node reads, so they can say what is wrong first.

/** Exit with what is wrong, and `next` (what to do once there is a newer Node), unless this Node runs TypeScript. */
export function needTypeScript(next) {
  if (process.features && process.features.typescript) return;
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  console.error(major > 22 || (major === 22 && minor >= 18) ? [
    `bateson: this Node (${version}, at ${process.execPath}) has its TypeScript support turned off, and bateson needs it.`,
    'Remove --no-experimental-strip-types from how Node is started (look in NODE_OPTIONS), then run this again.',
  ].join('\n') : [
    `bateson: needs Node 22.18 or newer, which runs its TypeScript files directly. This is Node ${version}, at ${process.execPath}.`,
    `Install Node 22.18 or newer, then ${next}.`,
  ].join('\n'));
  process.exit(1);
}
