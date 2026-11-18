#!/usr/bin/env node
// PostToolUse (edits and Bash): what Claude Code runs. Runs hooks/remind.ts, from its bundle when it is built (hooks/_node.mjs).
import { runHook } from './_node.mjs';

await runHook('remind');
