#!/usr/bin/env node
// Stop: what Claude Code runs. Runs hooks/nudge.ts, from its bundle when it is built (hooks/_node.mjs).
import { runHook } from './_node.mjs';

await runHook('nudge');
