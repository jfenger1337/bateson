#!/usr/bin/env node
// SessionStart and UserPromptSubmit: what Claude Code runs. Checks the Node (hooks/_node.mjs), then runs hooks/catchup.ts.
import { hookNeedsTypeScript } from './_node.mjs';

hookNeedsTypeScript('catchup');
await import('./catchup.ts');
