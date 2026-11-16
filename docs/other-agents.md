# Other agents

This page is a snapshot taken on 2026-11-15. Nobody keeps it up to date, and these tools change every month. Before you rely on a row, open the source linked next to it and check that the row is still true.

## What an agent needs for the full loop

bateson uses six capabilities of Claude Code. An agent that has all six can run the same loop.

1. **Run a shell command.** The agent sends with `bateson send`, which writes to `~/.bateson`. A sandbox that blocks writes outside the project blocks the send.
2. **Load a skill.** `skill/bateson/SKILL.md` tells the agent when to send and how. An agent that reads only `AGENTS.md` or rules files needs the same text there.
3. **Be told things at session start and on each prompt.** `hooks/catchup.ts` runs on `SessionStart` and `UserPromptSubmit`. It prints text that enters the agent's context, such as responses that no session has received yet.
4. **Be woken in an idle session when the answer arrives.** This capability matters most and is the rarest. `hooks/rewake.ts` runs after `bateson send` as a `PostToolUse` hook with `asyncRewake`. It waits in the background for up to four hours, then exits with code 2, and Claude Code starts a turn with the answer. If four hours pass first, it wakes the session to run `bateson rearm <id>`, which starts the hook again, for as long as the question is less than a day old. Without it, the agent has to keep its turn open or learn the answer on the next prompt.
5. **Know when a turn ends.** `hooks/nudge.ts` runs on `Stop` and marks the session idle. `hooks/remind.ts` then knows that the next turn without a prompt was not started by the user.
6. **A way to tell which tool is running a hook or command.** Claude Code sets `CLAUDECODE=1` in the environment of both its hooks and its shell commands. Observed on 2026-11-15 with Claude Code 2.1.325.

## What is decided

- Claude Code is the only supported agent. Supported means that the answer wakes the agent.
- Codex is planned. It has no date.
- Any other agent can send, then wait in short waits with `bateson wait`, and give up after about ten minutes. `bateson wait` then tells the agent to end its turn, and to run `bateson inbox` when the user next writes. This way of working is not called supported.
- bateson's hooks do nothing unless Claude Code started them. Other tools read `~/.claude/settings.json` and would run the hooks too (see [Things to know before building](#things-to-know-before-building)).
- Integrations from other people are welcome. Each one lives in its own folder and is marked with its author, the date, and the version it was tested on. An integration that breaks and that nobody fixes is removed.

## Codex

Each claim ends with its label.

- **Observed** means seen with Codex CLI 0.134.0 on the test machine.
- **Source** means read in the Codex source at tag `rust-v0.134.0`, from https://github.com/openai/codex.
- **Docs** means read at https://learn.chatgpt.com/docs/hooks. That page describes the current release, not 0.134.0.
- **Guess** means inferred and not seen.

Codex was signed out during the check, so no model turn ran. Everything that needs a model turn rests on source and has not been seen working. The newest published version on that day was 0.169.0. Observed. The docs list events and `async` hooks that 0.134.0 does not have, so an integration must name a minimum Codex version. Source.

### Where hooks are configured

- User hooks go in `~/.codex/hooks.json`, or in `[hooks]` tables in `~/.codex/config.toml`. Observed.
- Project hooks go in `<repo>/.codex/hooks.json` and load only when the user config marks the project as trusted. Observed.
- The file has the same shape as Claude Code's `hooks` block, and the handler fields are `type`, `command`, `commandWindows`, `timeout`, `async` and `statusMessage`. Source.
- Codex ignores unknown handler fields without a warning and drops unknown event names without a warning. Observed.
- Hooks run through the user's shell, in the session's working directory, outside the sandbox. Source.

### Each hook must be trusted, and a changed command loses its trust

- A hook does not run until the user has trusted it, with `/hooks` in the CLI or Settings > Hooks in the desktop app. Docs. Every new hook was listed as `untrusted`. Observed.
- Codex stores trust per hook in `~/.codex/config.toml`, as a hash under a key built from the file path, the event, and the hook's position in the file. Observed.
- The hash covers the event, the matcher, the command, the timeout and the status message. A change to any of them stops the hook until the user trusts it again. Source.
- The key is positional, so reordering `hooks.json` also changes the keys. Source.
- An installer that writes an absolute path into the command therefore un-trusts the hook whenever that path changes. Guess, from the two source claims above.

### Which of bateson's four hooks carry over

| Hook | Carries over | What changes |
|---|---|---|
| `catchup.ts` | yes | The stdin fields and the `hookSpecificOutput.additionalContext` output are the same. Observed. `SessionStart` runs when the first turn starts, not when the session opens. Observed. |
| `nudge.ts` | yes | Only registration and trust. A `Stop` hook may print nothing and exit 0. Source. |
| `remind.ts` | partial | Shell commands arrive as `Bash` with `tool_input.command`, as in Claude Code. File edits arrive as `apply_patch` with the patch text and no `file_path`, so the check that a file is inside the repository must parse the patch. Source. |
| `rewake.ts` | no | See the next section. |

Three details apply to all four hooks. Hook output JSON is strict, and an unknown top-level field fails the hook. Source. `tool_response` for a shell command is a plain string, which `rewake.ts` already accepts. Source. `PostToolUse` fires only when the command had finished by the time the tool call returned. Source.

### `asyncRewake` is ignored

- Codex 0.134.0 accepts a hook with `asyncRewake: true` and runs it as an ordinary synchronous hook with its full timeout. Observed.
- Copying bateson's Claude Code entry as it is would hold the `bateson send` tool call open while `rewake.ts` waits. Guess.
- Codex 0.134.0 skips `async: true` hooks with the warning `async hooks are not supported yet`. Observed.
- In the current release, the output of an `async` hook waits for the next user turn when the session is idle. Docs. So no Codex release wakes an idle session from a hook.

### Two possible substitutes for the wake-up

**A `Stop` hook that waits, then continues the turn.** A `Stop` hook that exits with code 2 and a reason on stderr, or prints `{"decision":"block","reason":"..."}`, makes Codex continue the turn with the reason as a new message. Source and docs. The default timeout is 600 seconds, and `timeout: 14400` was accepted. Observed. On timeout Codex kills the hook and the turn ends normally. Source. The turn never ends while the hook waits, so this substitute is a long turn and not a wake-up. Nobody has run it live, and what the terminal shows during a wait of hours is unknown.

**`turn/start` over the app server.** An outside process sent `thread/start` and then `turn/start` to `codex app-server`, and the turn ran with its hooks. Observed. This is a true wake-up, but only for sessions that run through an app server. The terminal UI can attach with `codex --remote <addr>`. Observed. Whether a turn started by a second client appears in an attached terminal UI is a guess. The websocket transport is marked experimental. Source.

### Limits that affect `bateson send` and `bateson wait`

- **One shell call blocks for 30 seconds at most.** The call returns after `yield_time_ms`, which is capped at 30 000. The command keeps running, and the model polls it with `write_stdin` for up to five minutes per poll by default. Source. So `bateson wait` works only while the model chooses to keep polling. How reliably it does so is a guess.
- **The sandbox does not list `~/.bateson` as writable.** `codex exec` ran with `workspace-write` and the roots `workdir`, `/tmp` and `$TMPDIR`. Observed. That `bateson send` is then denied is a guess and was not tested. The key `sandbox_workspace_write.writable_roots` adds a folder. Source.
- **Hooks did not run in `codex exec`.** In three runs with `--dangerously-bypass-hook-trust`, no `SessionStart` or `UserPromptSubmit` hook ran. Observed. The same hooks ran through `codex app-server` once they were trusted. Observed. Whether `codex exec` runs trusted hooks was not tested.

### Skills

Codex loads user skills from `~/.agents/skills`, and from `~/.codex/skills`, which the source calls deprecated. Source. It follows symlinked skill folders. Source, and docs at https://learn.chatgpt.com/docs/build-skills. Nobody has tested that Codex picks up and triggers the bateson skill.

## Other agents

Everything in this section comes from vendor documentation read on 2026-11-15, unless a sentence says third-party, guess or unknown. Nothing was run. "No" under "Woken when idle" means that the pages read describe no way to do it. "Yes" can mean through plugin code and not a hook file. The lines under the table say which.

| Agent | Shell | Skills | Told at start and on each prompt | Woken when idle | Turn-end hook | One shell call can wait minutes |
|---|---|---|---|---|---|---|
| Cursor (IDE and CLI) | partial | yes | partial | no | yes | unknown |
| Gemini CLI | yes | yes | yes | no | yes | unknown |
| Antigravity CLI | unknown | yes | yes | no | yes | unknown |
| OpenCode | yes | yes | yes | yes | partial | yes |
| Copilot CLI and VS Code | yes | yes | partial | no | yes | unknown |
| Pi | yes | yes | yes | yes | yes | unknown |
| Amp | yes | yes | partial | partial | yes | unknown |
| Aider | partial | no | no | no | no | unknown |
| Claude desktop app, Code tab | yes | yes | yes | unknown | yes | unknown |

How each of these tools identifies itself to a hook or a command was not researched. Treat it as unknown for every row.

**Cursor.** The sandbox blocks the network and writes outside approved paths by default. Extra paths go in `~/.cursor/sandbox.json`. Whether `~/.bateson` and `127.0.0.1` work without an entry is unknown (https://cursor.com/docs/agent/run-modes). `sessionStart` adds context, and `beforeSubmitPrompt` cannot. `stop` returns a `followup_message` and is capped at 5 loops by default (https://cursor.com/docs/agent/hooks). Cursor loads Claude Code hooks from `~/.claude/settings.json` by default (https://cursor.com/docs/reference/third-party-hooks). Whether hooks other than `workspaceOpen` run in the CLI is unknown.

**Gemini CLI.** Its docs say that Antigravity CLI replaced it on 2026-06-18 for unpaid and Google One users (https://geminicli.com/docs/). `SessionStart` and `BeforeAgent` add context. `AfterAgent` with `decision: "deny"` sends `reason` as a new prompt. Hook timeouts default to 60 seconds (https://geminicli.com/docs/hooks/reference/). Skills load from `~/.gemini/skills` or `~/.agents/skills`, and activating one asks the user for consent (https://geminicli.com/docs/cli/skills/).

**Antigravity CLI.** Hooks live in `.agents/hooks.json` or `~/.gemini/config/hooks.json`. `SessionStart` and `PreInvocation` inject messages, and `Stop` with `decision: "continue"` re-enters the loop. Hook timeouts default to 30 seconds (https://www.antigravity.google/docs/hooks). Global skills load from `~/.gemini/config/skills`, and `~/.agents/skills` is not listed (https://www.antigravity.google/docs/skills). Sandbox behaviour is unknown.

**OpenCode.** It has no hook file. Everything goes through plugin code in `.opencode/plugins/` or `~/.config/opencode/plugins/` (https://opencode.ai/docs/plugins/). `ctx.session.prompt({ sessionID, text })` sends a user prompt. That a plugin can call it from its own watcher while the session is idle is a guess. No stop hook is documented (https://opencode.ai/docs/build/plugins/server). The shell tool has a two-minute default timeout and a per-call `timeout` parameter (https://opencode.ai/docs/tools/). Skills load from `~/.claude/skills` and `~/.agents/skills` among others (https://opencode.ai/docs/skills/).

**Copilot CLI and VS Code.** `sessionStart` adds context. The output of `userPromptSubmitted` hooks is dropped. `agentStop` with `decision: "block"` forces another turn, 8 times in a row at most. `timeoutSec` defaults to 30. The CLI reads hooks from the repository's `.claude/settings.json` but not from `~/.claude/settings.json` (https://docs.github.com/en/copilot/reference/hooks-configuration). Personal skills load from `~/.copilot/skills` and `~/.agents/skills`, and `~/.claude/skills` is not listed (https://docs.github.com/en/copilot/concepts/agents/about-agent-skills). VS Code agent hooks are in preview (https://code.visualstudio.com/docs/copilot/customization/hooks).

**Pi.** It has the closest match to `asyncRewake`. In a TypeScript extension, `pi.sendMessage(message, { triggerTurn: true })` is documented as "If agent is idle, trigger an LLM response immediately", and the docs list a file-watcher example. `before_agent_start` adds a message, and `agent_end` marks the end of a turn. Extensions load from `~/.pi/agent/extensions/` and `.pi/extensions/` (https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md). Skills load from `~/.agents/skills`, and `~/.claude/skills` is not mentioned (https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/skills.md).

**Amp.** Plugins run under Bun from `.amp/plugins/` or `~/.config/amp/plugins/`. `agent.start` appends a message to each turn, and nothing is described for `session.start`. `agent.end` can continue the turn, 5 times in a row by default (https://ampcode.com/docs/customize/plugins). `appendUserMessage` exists on a thread, and the page does not say whether it starts a turn on an idle thread (https://ampcode.com/docs/plugin-api). Skills load from `~/.claude/skills` and `~/.agents/skills` among others (https://ampcode.com/docs/customize/skills).

**Aider.** It has no hooks and no skills option. It suggests shell commands and runs the configured lint and test commands. `--read FILE` adds a read-only conventions file (https://aider.chat/docs/config/options.html). The release history through v0.86.1 mentions no MCP, hooks or skills (https://aider.chat/HISTORY.html).

**Claude desktop app, Code tab.** Desktop and the CLI read the same configuration files, and local sessions load `~/.claude/skills` (https://code.claude.com/docs/en/desktop). Claude Code "fires the same hook events wherever it runs", and an `asyncRewake` hook that exits with code 2 wakes an idle session (https://code.claude.com/docs/en/hooks). Neither page names Desktop for `asyncRewake`, so that it works in a local Code tab session is a guess and needs one live test. Cloud sessions do not read the local `~/.claude/settings.json`. The Code tab runs its own copy of Claude Code, which can differ from the terminal version.

### Agents with hooks that were not assessed in full

- **Factory Droid** uses the Claude Code event names and output shape in `~/.factory/hooks.json`, with a default timeout of 60 seconds (https://docs.factory.com/reference/hooks-reference).
- **Devin CLI and Devin Desktop**, formerly Windsurf, read hooks from `.claude/settings.json`, `~/.claude/settings.json` and `~/.claude.json` by default. A way for `Stop` to continue the turn is not documented (https://docs.devin.ai/cli/extensibility/hooks/overview.md, https://docs.devin.ai/desktop/cascade/hooks).
- **Kiro** has `PreToolUse`, `PostToolUse` and `Stop` triggers in `.kiro/hooks/*.json`. The page does not say whether a hook can inject context or block a stop (https://kiro.dev/docs/hooks/).
- **Cline** has SDK plugin hooks with a timeout of 3 seconds (https://docs.cline.bot/sdk/plugins.md).

## Things to know before building

**There is no shared hooks standard.** A search found comparison articles and no specification. Agent Skills has a standard, and its overview says nothing about hooks (https://agentskills.io/home). Claude Code's contract of JSON on stdin, JSON on stdout and exit code 2 recurs in Codex, Factory Droid, Devin CLI, Gemini CLI, Antigravity, Copilot and Cursor, but the field names differ. Context at session start is `additional_context` in Cursor, `hookSpecificOutput.additionalContext` in Codex, Gemini CLI, Droid and Devin, `additionalContext` in Copilot, and `injectSteps` in Antigravity. Continuing after a stop is `followup_message` in Cursor, `decision: "block"` in Codex, Copilot and Droid, `decision: "deny"` in Gemini CLI, and `decision: "continue"` in Antigravity.

**Three tools read Claude Code's own hook settings.** Cursor and Devin CLI read `~/.claude/settings.json` by default. Copilot CLI reads only the repository's `.claude/settings.json` and `.claude/settings.local.json`. The hooks that bateson installs for Claude Code are therefore loaded by Cursor and Devin on the same machine. How either treats an `asyncRewake` entry is unknown.

**The skills folders overlap but do not match.** The documentation lists `~/.claude/skills` for Cursor, OpenCode, Amp and Claude Code. It lists `~/.agents/skills` for Cursor, Gemini CLI, OpenCode, Copilot, Pi and Amp, and the Codex source reads it too. Antigravity reads neither and wants `~/.gemini/config/skills`.

**Hook timeouts are short outside Claude Code and Codex.** Claude Code and Codex default to 600 seconds, and Claude Code allows 30 seconds on `UserPromptSubmit`. The defaults elsewhere are 60 seconds in Gemini CLI, Droid and Kiro, 30 seconds in Antigravity and Copilot, and 3 seconds in Cline. Cursor states only a "platform default". No vendor page states a maximum. A stop hook that waits for the answer is the most widely available substitute for a wake-up, and whether any tool lets it wait for hours is unknown.

**A held-open MCP tool call is not general.** The ceilings differ by a factor of several hundred.

| Tool | Tool-call timeout | Label |
|---|---|---|
| Codex 0.134.0 | 120 seconds by default, set per server with `tool_timeout_sec` | source |
| Cursor | 60 seconds, not configurable | third-party (https://github.com/that-mathevs/apple-native-mcp/issues/25) |
| Pi | 60 seconds by default, and progress notifications reset it | documented (https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/mcp.md) |
| Gemini CLI | 10 minutes by default, set per server | documented (https://geminicli.com/docs/tools/mcp-server/) |
| OpenCode | 12 hours by default | documented (https://opencode.ai/docs/mcp-servers/) |
| Amp, Copilot CLI, Antigravity | unknown | not on the pages read |

**Shell waits are mostly undocumented.** Only OpenCode documents its shell timeout, and the Codex source gives 30 seconds per call. For every other tool, how long one `bateson wait` call can block is unknown.
