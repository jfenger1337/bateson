# Reference

The keys, the settings and the parts of bateson. The [README](../README.md) covers what it is and how to install it.

## Keys

Hold `⌘` in the app to see the keys for the screen you are on. On Windows it is `Ctrl` wherever this page says `⌘`.

| Where | Keys |
|---|---|
| Interview | `A`–`I` choose an option, `W` write your own (`⌘V` or a drop puts a screenshot in it), `J`/`K` or `←`/`→` move between questions, `⏎` next (on the last question it sends), `⇧⏎` send now: only the answers you gave so far, and the interview goes on. |
| Findings | `K` keep, `X` dismiss (type a reason if you like), `C` comment, `←`/`→` move, `⏎` next, `⌘⏎` send, `L` later, `⇧D` drop. |
| Review | On code, select lines then `C` to comment. Click the title to comment on the whole piece. `A` approve, `S` send back, `L` later, `⇧D` drop. |
| Anywhere | `⌘Z` undoes a decision for a few seconds. `⌘,` opens settings. |

## Settings

Open them with `⌘,` (`Ctrl+,` on Windows). They live in `~/.bateson/config.json`, and [`folder-format.md`](./folder-format.md) describes every key.

| Setting | What it does |
|---|---|
| Your name | What agents call you. It starts as the first name in your git config. |
| Appearance | Light, dark or the system's. |
| Preview beside questions | A panel that shows what a question is about (a screenshot, a component, a live page). Not available for now, so agents ask in words only. A sound on an option still plays. |
| Notification sound | On or off. |
| Hotkey | Brings the window forward (Mac app). |
| Time to undo | How long a decision can be taken back before the agent hears it. |
| When a session is waiting on you | Notify, notify and bring the window forward, or nothing. |
| What agents bring you | Questions and decisions, plans, findings, code. |
| Check for new versions | Once a day, ask GitHub whether there is a newer bateson. On by default. Nothing is installed until you press **Update** under Updates. |
| Questions asked in the terminal | Two or more questions an agent asks with Claude Code's own form (`AskUserQuestion`) come to bateson instead, and the agent waits for your answer. On by default. Off, or with questions and decisions turned off, the form shows in the terminal. |
| Remind agents to ask you | A quiet reminder on turns you did not start. |

## The parts

| Path | What |
|---|---|
| [`cli/bateson.mjs`](../cli/bateson.mjs) | What the `bateson` command starts. Plain JavaScript, so that on a Node older than 22.18 it first runs itself again with the Node bateson was installed with (noted in `install.json`), and only if there is none says so, and what to do, instead of failing on the `.ts` extension ([`lib/node-check.mjs`](../lib/node-check.mjs)). Then it runs `cli/bateson.ts`. |
| [`cli/bateson.ts`](../cli/bateson.ts) | `bateson send / status / wait / rearm / cancel / inbox / list / recall / serve`. After a send it tells the agent what to do next: end the turn where a wake-up is in place, wait where it is not. `cancel` is what an agent runs when you tell it in the terminal to stop: the item leaves the app, and the wait for it ends without waking anyone. |
| [`lib/store.ts`](../lib/store.ts) | The queue on disk, shared by everything. |
| [`lib/update.ts`](../lib/update.ts) | Updates from the app. It checks once a day with `git fetch`. **Update** fast-forwards `~/bateson` to GitHub's version, runs `npm ci` if the dependencies changed, builds, runs the installer, and rebuilds the Mac app if it changed and is installed. Then the server quits, and launchd, `scripts/keepalive.ts` or `bateson serve` starts the new one. A checkout with changed files or commits of its own is left alone, and so is a new version that needs a newer Node than bateson runs on (its `engines` in `package.json`): the app says which, and what to do. A failed build goes back to the commit it started from. A server nothing restarts (started with `npm start`, say) is not stopped: the empty screen and Settings offer **Restart**, which starts the new server in the background, with its output in `~/.bateson/server.log`, and quits the old one. |
| [`lib/recall.ts`](../lib/recall.ts) | `bateson recall`: what you already decided, one line each, so agents check before asking again. It reads the queue's files on every call: no index, no model. A decision must have every word asked for (a ticket key counts as one word), and only when none has does it fall back to those with most of them. A question asked again shows once, at your latest answer, noting whether it changed. Also the overrides a new session hears about. |
| [`lib/agent.ts`](../lib/agent.ts) | Which agent is running a command or hook, and whether a response can wake it. |
| [`hooks/*.mjs`](../hooks) | What Claude Code runs: each checks the Node, as `cli/bateson.mjs` does, then runs the hook of the same name below. On a Node that cannot, the hook error Claude Code shows says so, and so does `~/.bateson/hooks.log`. The hook runs from its bundle in `hooks/dist`, which `npm run build` makes ([`scripts/build-hooks.ts`](../scripts/build-hooks.ts)) and which starts several times faster than the TypeScript, as long as no file that went into it has changed since; otherwise from source. `rewake.mjs` ends at once on a Bash call that is not bateson's. |
| [`hooks/rewake.ts`](../hooks/rewake.ts) | After a send, waits for your response and wakes the session that sent it. It gives up when that session closes or moves on (`/clear`), so the response is left for a session that can use it. Claude Code stops it after four hours, so two minutes before that it wakes the session to run `bateson rearm <id>`, which starts it again. It stops renewing once the question is a day old. |
| [`hooks/catchup.ts`](../hooks/catchup.ts) | On a prompt and at session start (a resume or a compaction): hands the session responses to what it sent. Never one another session sent, even once that one has ended: `bateson inbox` takes those on purpose. Also tells the agent what you want brought to you and, at session start, the last five times you went against an agent's recommendation in this repository (an option other than the one recommended, or your own answer), so its recommendations lean your way. When you write while something it sent is still waiting, it also names that item and how to cancel it if your message calls it off. |
| [`hooks/nudge.ts`](../hooks/nudge.ts) | When a turn ends: marks the session idle and records the working tree. |
| [`hooks/ask.ts`](../hooks/ask.ts) | Before Claude Code shows its own question form (`AskUserQuestion`): sends two or more questions to the queue as an interview round instead, and tells the agent to run `bateson rearm <id>` and end its turn, so your answer wakes it as after a send. An option the agent marked "(Recommended)" is the round's recommendation. The form is left to the terminal for a single question (that is asked in chat, never sent), when the setting is off, when nothing can wake the session, and when a question lets you pick several options, which a round cannot show. |
| [`hooks/remind.ts`](../hooks/remind.ts) | The first time a turn you did not start changes files, quietly reminds the agent that calls which are yours go to the queue. It never blocks. |
| [`skill/`](../skill) | The skills. |
| [`server/server.mjs`](../server/server.mjs) | What starts the server (`npm start`, `bateson serve`, the login item): checks the Node, as `cli/bateson.mjs` does, then runs `server/server.ts`. On a Node that cannot, it says so in `~/.bateson/server.log`, and in `server.error`, which the Mac app shows in place of its wait for the server. Started at login, it also answers on the port for a minute with why, so a browser shows it too (an open page says so in its bar), then leaves for launchd to try again. |
| [`server/server.ts`](../server/server.ts) | Hono on `:4848`: the API, live updates, the built UI. Local requests only. It watches the queue's folder and tells open pages of a change they may show; a waiting hook's heartbeat on `waiter.json`, the logs and session working-tree records are not one. Every 15 seconds, while a page is open, it also works the state out itself, for what leaves no file behind (a hook or a session that ended), and tells the pages only if that reads differently. It keeps what it read of done items until the watcher says one changed, and reads them all again every 5 minutes. |
| [`web/`](../web) | Vite and React 19. |
| [`web/public/waiting.html`](../web/public/waiting.html) | What bateson shows while its server is down (at login, during an update's restart), in place of the browser's error page: "Waiting for the bateson server", or why it cannot start (a Node too old for it), filled in by the Mac app and by the login item standing in for the server ([`lib/node-check.mjs`](../lib/node-check.mjs)). It goes back to bateson once the server answers. The browser gets it from the service worker, [`web/public/sw.js`](../web/public/sw.js), which steps in only when a page load fails and caches nothing of bateson but this page and its font; it works from the second load on, and a hard reload (Ctrl+Shift+R) skips it. The Mac app has its own copy, put in by `mac/build.sh`. |
| [`mac/`](../mac) | The Mac shell, AppKit and WKWebView. `./mac/build.sh --install` puts it in `~/Applications`. While there is no server, it shows `web/public/waiting.html`, with why if the server left a reason (`server.error`: a Node too old for it). |
| [`scripts/install.mjs`](../scripts/install.mjs) | What you run to install: checks the Node, as `cli/bateson.mjs` does, then runs `scripts/install.ts`. |
| [`scripts/install.ts`](../scripts/install.ts) | Sets all of it up, and `--uninstall` takes it away. `--login` starts the server at login: a launchd item on a Mac, a value in the user's `Run` key on Windows. |
| [`scripts/keepalive.mjs`](../scripts/keepalive.mjs) | What the Windows login item runs: checks the Node, then runs `scripts/keepalive.ts`. On a Node that cannot, it answers on the server's port with why until the installer stops it, so the browser shows it. |
| [`scripts/keepalive.ts`](../scripts/keepalive.ts) | On Windows, what the login item runs: it keeps the server running, as launchd does on a Mac. |

## Working on it

`npm start` runs the server. `npm run dev` runs Vite on `:5848` with the API proxied. `npm run typecheck` checks the app and the contract it shares with the server.

`BATESON_HOME` and `BATESON_PORT` point everything at another queue, so you can try changes without touching your own. An install with `--login` made with them set keeps them: the server at login is given both, and the Mac app the port and the queue (saved in its defaults, as `defaults read app.bateson` shows). `BATESON_CLAUDE_DIR` points at another list of running Claude Code sessions (normally `~/.claude/sessions`). On Windows and in WSL, `bateson send` opens the page when none is open, in a window of its own (Chrome's or Edge's `--app`), else in the default browser; `BATESON_NO_OPEN` turns that off, and `BATESON_OPEN_WITH` opens it with another program instead of `explorer.exe`.

When a hook fails, it exits quietly so the session carries on, and writes a line to `~/.bateson/hooks.log`. Settings says when the last day has any.
