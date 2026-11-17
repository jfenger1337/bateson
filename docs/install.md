# Installing bateson for someone

These are the steps for a coding agent that was asked to install bateson. A person installing by hand can follow the five commands in the [README](../README.md#install).

The rules in the prompt you were given come first. If anything here disagrees with them, follow the prompt.

## 1. Check, and change nothing

Stop with a plain sentence if one of these fails. Do not install or upgrade anything to get past a check.

- The machine runs macOS, or Windows 10 or 11. On Windows, Claude Code runs your commands in Git Bash, and the commands below are written for it.
- `node --version` is 22.18 or newer.
- `git` and `npm` are on the path.
- [Claude Code](https://claude.com/claude-code) is installed (`~/.claude` exists).

Then look at `~/bateson`, or the folder the prompt names:

- If it does not exist, this is a new install. Port 4848 should be free: `lsof -i :4848` on a Mac, `netstat -ano | grep ':4848 .*LISTENING'` on Windows, prints nothing. If something is listening there, stop and say what it is.
- If it is a clone of bateson (`git -C ~/bateson remote get-url origin` ends in `bateson` or `bateson.git`), this is an update. The server on port 4848 is the old one and the installer replaces it.
- If it is anything else, stop and say so.

## 2. Clone and build

This touches only the bateson folder and npm's own cache, so it needs no yes.

```bash
git clone https://github.com/jfenger1337/bateson.git ~/bateson   # or the source the prompt names
cd ~/bateson
npm install
npm run build
```

For an update, run `git pull` in `~/bateson` in place of the clone. If the pull fails because of local changes, stop and say so.

## 3. Say what will change, and ask once

The next two steps touch the person's own setup. Before either, tell them what will change and wait for a yes. Look first, and say only what applies to their machine.

The installer will:

- Put a `bateson` command in `~/.local/bin`. On Windows that is two small files, `bateson.cmd` and `bateson` (for Git Bash).
- Link bateson's skills (`bateson`, `ama`, `setup-bateson`) into `~/.claude/skills`. On Windows the links are directory junctions, which need no admin rights. If they have a `grilling` skill, it is moved to `~/.claude/skills-backup` and replaced with one that interviews through bateson.
- Add hooks to `~/.claude/settings.json`. If the file exists, a backup is kept next to it.
- Add a login item and start it straight away. It runs a local server on port 4848. On a Mac it is `~/Library/LaunchAgents/com.bateson.server.plist`. On Windows it is a value named `bateson` in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which starts `scripts/keepalive.ts` without a window; that keeps the server running.
- Create the queue folder `~/.bateson`, with a settings file that holds the first name from their git config, so agents know what to call them.

If Apple's command line tools are there (step 5), the Mac app build will also put `bateson.app` in `~/Applications`, and restart it if it is running. There is no Windows app for now: on Windows bateson is http://localhost:4848 in their browser.

Nothing is sent anywhere, and `node scripts/install.ts --uninstall` undoes all of it except the queue folder and the app.

## 4. Run the installer

```bash
node scripts/install.ts --login
```

(`--launchd`, the old name, still works.)

It prints every file it touched. Pass that list on as it is.

If it stops partway, the lines it printed are what it already did. Say so, with the error. Running it again and `node scripts/install.ts --uninstall` are both safe from there, and which one is the person's call.

## 5. The app

The app adds a notification when an agent is waiting, a count, and a hotkey.

On a Mac, build it only if Apple's command line tools are already there:

```bash
xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null && ./mac/build.sh --install
```

If they are missing, do not install them. Say that the app was skipped, and that `xcode-select --install` followed by `./mac/build.sh --install` in `~/bateson` adds it later.

On Windows there is no app to build: skip this step. bateson there is the page at http://localhost:4848.

## 6. Check and hand over

- `curl -s -o /dev/null -w '%{http_code}' http://localhost:4848` should print `200`. If it does not, show the last lines of `~/.bateson/server.log` and stop.
- Open the window. On a Mac: `open -a bateson` if the app was built, otherwise `open http://localhost:4848`. On Windows: `start http://localhost:4848`, and tell them that when an agent asks them something, bateson opens this page in their browser if it is not open already.

Then tell the person, in a few lines:

- What was installed, from the installer's list.
- That the folder at `~/bateson` has to stay where it is, because the command, the skills and the login item point into it.
- If `~/.local/bin` is not on their `PATH` (`command -v bateson` finds nothing in a new shell), that they need to add it, and the line for their shell. On Windows they add it under Settings, System, About, Advanced system settings, Environment Variables, to their user `Path`; Claude Code's own Windows installer usually has already. Do not edit their shell files or their `Path`.
- That the login item and the hooks use the Node that ran the installer. After removing or switching that Node version, they run the installer again.
- That this session does not have the new hooks and skills. They should start a new Claude Code session and run `/setup-bateson` there to choose what agents bring them.

## When a step fails

Stop. Say which step failed, quote the error, and say what would fix it. Leave the machine as it is: no installing Node, no switching version managers, no editing shell files. The person fixes it and runs the prompt again, and every step here is safe to run twice.
