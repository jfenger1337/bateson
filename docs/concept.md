# bateson

A local, one-player queue of everything AI work is blocked on: your judgment. One thing at a time, no tabs. You review and decide. You never write prompts.

Agreed in a grilling session on 2026-11-08.

## What comes in

Only what an agent cannot go on without a human for:

- **Decisions**: direction, trade-offs, product choices. Sent as an interview: rounds of questions, each with options and a recommendation.
- **Taste**: copy, UI, naming, anything where "correct" means "you like it".
- **Plans for big work**, before building.

Not sent: work an agent can check itself (a refactor with passing tests, a lint fix), and recurring output like briefs and logs.

Kinds of item: **work to review** (markdown, text, diff, findings) and **decisions** (questionnaire rounds).

## How it comes in

- Agents send deliberately with `bateson send`, following the global `bateson` skill.
- The CLI captures the body itself (`--diff`, `--file`, `--stdin`, `--questions`). The agent writes only the title and the note: what this is, where to look.
- One main body plus attachments.
- Repo, branch, cwd and session are attached automatically.
- A newer version of an item replaces the unread one in place.
- The folder format in `~/.bateson/` is the contract (see `folder-format.md`). Any producer can write it.

## Reviewing

- **Interviews**: the interview is the item, each round a version. Click an option; the recommendation is preselected (dashed ring) until you touch it (filled dot). "Write your own" is the one free-text field in the app. Earlier rounds show above as settled decisions.
- **Work**: select and comment, Agentation-style. Notes sit in a right margin, anchored to a passage, a file and line, or the title for the whole piece.
- No other text input anywhere.

## Decisions

One key each, no notes:

| Key | Work | Interview |
|---|---|---|
| `A` / `⌘⏎` | Approve: the agent carries on | Send answers |
| `S` | Send back: your comments are the message | |
| `⇧D` | Drop: the agent stops, changes stay | End the interview |
| `L` | Later: to the back of the queue | Later |

Order: revisions and next rounds first, then items a live session is waiting on, then oldest first.

## The loop

- `PostToolUse` hook on `bateson send`, with `asyncRewake`: waits in the background and wakes the session with the response.
- `UserPromptSubmit` hook: hands a session any response to what it sent that arrived after the waiting hook gave up.
- `SessionStart` hook: hands a resumed or compacted session responses to what it sent that it never received. A response never goes to another session on its own, even once the one that asked has ended; resume that one, or run `bateson inbox` in its repo to take it on purpose. At its start it also tells the session the last few times you went against an agent's recommendation in that repo.
- `Stop` hook: notes that the session is idle. On a turn you did not start, a `PostToolUse` hook quietly reminds the agent, the first time it changes files, that calls which are yours go to the queue.
- All global, in `~/.claude/`, and silent unless Claude Code started them.

## Stack

- Plain files in `~/.bateson/`. Decided items move to `done/`. Nothing is deleted.
- Vite + React 19 + plain CSS.
- Hono server on `:4848`, serving the UI and watching the folder.
- Later: a SwiftUI + WKWebView shell with a menubar count, ⌥Space, notifications when a live session is blocked, launch at login.

## Build order

1. The loop, interviews first and polished, plus plain markdown and diff items with select-and-comment.
2. Findings, versions with notes marked addressed or open, outward-action gates, screenshots.
3. The Mac shell.

## Parked

History view, intercepting every `AskUserQuestion`, Agentation over running apps, Channels, collectors (GitHub PR review requests first).
