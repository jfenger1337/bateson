#!/usr/bin/env node
// PostToolUse (edits and Bash): what Claude Code runs. Checks the Node (hooks/_node.mjs), then runs hooks/remind.ts.
import { hookNeedsTypeScript } from './_node.mjs';

hookNeedsTypeScript('remind');
await import('./remind.ts');
