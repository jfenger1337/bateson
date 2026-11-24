#!/usr/bin/env node
// PreToolUse (AskUserQuestion): what Claude Code runs. Runs hooks/ask.ts, from its bundle when it is built
// (hooks/_node.mjs).
import { runHook } from './_node.mjs';

await runHook('ask');
