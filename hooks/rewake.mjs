#!/usr/bin/env node
// PostToolUse (Bash), asyncRewake: what Claude Code runs. Checks the Node (hooks/_node.mjs), then runs hooks/rewake.ts.
import { hookNeedsTypeScript } from './_node.mjs';

hookNeedsTypeScript('rewake');
await import('./rewake.ts');
