#!/usr/bin/env node
// PostToolUse (Bash), asyncRewake: what Claude Code runs. Runs hooks/rewake.ts, from its bundle when it is built
// (hooks/_node.mjs).
import { readInput, runHook } from './_node.mjs';

// It runs after every Bash call, and only one that is bateson's (`bateson send`, `draft` or `rearm`) concerns it:
// any other ends here, before the rest loads.
if (!readInput().includes('bateson')) process.exit(0);
await runHook('rewake');
