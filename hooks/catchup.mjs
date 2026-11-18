#!/usr/bin/env node
// SessionStart and UserPromptSubmit: what Claude Code runs. Runs hooks/catchup.ts, from its bundle when it is built (hooks/_node.mjs).
import { runHook } from './_node.mjs';

await runHook('catchup');
