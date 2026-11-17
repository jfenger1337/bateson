#!/usr/bin/env node
// Stop: what Claude Code runs. Checks the Node (hooks/_node.mjs), then runs hooks/nudge.ts.
import { hookNeedsTypeScript } from './_node.mjs';

hookNeedsTypeScript('nudge');
await import('./nudge.ts');
