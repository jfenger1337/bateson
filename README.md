# bateson

a window where your coding agents ask you things, one at a time, and wait for the answer.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img src="docs/screenshot-light.png" alt="bateson showing one question from an agent, with its options and the agent's recommendation">
</picture>

i'm [jonas](https://github.com/jfenger1337). a while ago i started using interview skills with claude code. before any real work, the agent asks me questions until every decision that matters is mine and written down. it worked so well that i now do most of my work that way.

a terminal is a poor place for it, though. long questions scroll past and the options are hard to compare. with several agents running, i would find one that had been waiting on me for an hour, or one that never asked, guessed, and built on the guess.

so i made a proper place for it. when an agent needs me, it sends the question to bateson and stops. i answer in one window, one question at a time, and the agent picks up again with my answer, even if that is two hours later.

every question comes with a few options and what the agent would choose, with its reasons. taking that is one key. if i disagree, i click another option or write a sentence. all of it runs on my own machine. the queue is a folder (`~/.bateson`) and nothing is sent anywhere.

today it's for one person, on a mac, using claude code. it runs on windows too, and every push installs and uninstalls it on a windows machine automatically, but i don't use windows day to day. if something breaks there, tell me.

fork it and change it to suit you. PRs are welcome.

## install

you need macOS or Windows 10/11, node 22.18 or newer, and [claude code](https://claude.com/claude-code).

it's early. the installer adds hooks to every claude code session on your machine, and uninstall takes them out again.

the easy way is to let claude code do it. paste this into a session:

```
install bateson for me from https://github.com/jfenger1337/bateson.

- clone it into ~/bateson and follow docs/install.md in the repository.
- before you change anything outside ~/bateson, tell me what you will change and wait for my yes.
- if a step fails, stop and tell me what failed and what would fix it. don't install or upgrade anything else to get past it.
- if ~/bateson already holds bateson, update it and run the installer again.
```

it asks you once, before it touches your claude code settings. [`docs/install.md`](./docs/install.md) is what it follows, if you want to read that first.

or by hand, which comes to the same thing:

```bash
git clone https://github.com/jfenger1337/bateson.git ~/bateson
cd ~/bateson
npm install
npm run build
node scripts/install.ts --login
```

on windows, the same in powershell:

```powershell
git clone https://github.com/jfenger1337/bateson.git $HOME\bateson
cd $HOME\bateson
npm install
npm run build
node scripts/install.ts --login
```

either way you get the `bateson` command on your path, the skills linked, the hooks added to `~/.claude/settings.json` (with a backup), and the server started at login. the installer lists every file it touched.

two things to know afterwards:

- keep the folder where it is. the command, the skills and the login item all point into it. if you move it, run the installer again from the new place.
- after a `git pull`, run `npm run build` and the installer again. files get renamed now and then, and the installer points everything at the new ones.

## get started

1. open http://localhost:4848. or build the app, which adds a notification when an agent is waiting on you, a count, and a hotkey. the install prompt builds it for you when it can.
   - mac: `./mac/build.sh --install` (needs apple's command line tools).
   - windows: `powershell -ExecutionPolicy Bypass -File windows\build.ps1 -Install` (needs the [.NET 10 SDK](https://dotnet.microsoft.com/download)). it lives in the tray, and `ctrl+alt+space` brings it up.
2. start a new claude code session and run [`/setup-bateson`](./skill/setup-bateson/SKILL.md) to choose what agents bring you. out of the box they bring questions and decisions only.
3. work as usual.

when an agent needs you, its question is waiting in the window. you answer, and the agent that sent it wakes up. if you closed that terminal, the next session in the same repository gets the answer. while the session that asked is still open, no other session gets it.

mostly you don't have to ask for any of this. agents send on their own when they reach a call that is yours, because the [`bateson` skill](./skill/bateson/SKILL.md) tells them when and how. you can also ask:

```
/ama i want to add team accounts. ask me anything before you build.
```

```
put the plan in bateson before you start.
```

```
review the sign-in code and send me the findings.
```

## what can come to you

| kind | what you see | on by default |
|---|---|---|
| decisions | a round of questions. each has two to four options and the agent's recommendation. | yes |
| taste calls | the same, for copy, naming, a sound, anything where right means you like it. | yes |
| plans | the plan before big work starts. you approve it or send it back with a note. | no |
| findings | review findings one at a time. you keep, dismiss or comment, and the agent fixes only what you kept. | no |
| code | the diff. you select lines and comment, then approve or send it back. | no |

turn the last three on with [`/setup-bateson`](./skill/setup-bateson/SKILL.md) or in settings (⌘, on a mac, ctrl+, on windows).

## skills

| skill | use it when |
|---|---|
| [`/ama`](./skill/ama/SKILL.md) | you want your thinking tested before work starts. the agent interviews you in bateson, a round of questions at a time, until every call that matters is yours and written down. |
| [`/setup-bateson`](./skill/setup-bateson/SKILL.md) | you want to change what agents bring you. it asks in bateson itself. |
| [`bateson`](./skill/bateson/SKILL.md) | never by hand. agents load it when they are blocked on a call that is yours. it tells them how to send and how to write for you. |

if you use matt pocock's grill skills (`grill-me`, `grill-with-docs`, `triage`, `wayfinder`, `improve-codebase-architecture`), the installer also swaps your `grilling` skill for [two lines](./skill/grilling/SKILL.md) that point them at `/ama`, so they interview through the queue. yours goes to `~/.claude/skills-backup/` and comes back on uninstall.

## which agents

claude code only, for now. i count an agent as supported when it can end its turn and be woken by your answer, and today only claude code can do that through plain settings. it's also the one i use every day, so i notice when the loop breaks. these tools change their hooks every few weeks, and a queue that quietly loses your answer is worse than no queue.

in the claude app, cloud sessions can't use bateson. they run on another machine and never see your queue. local sessions in the code tab read the same settings as the terminal, so they should work, but i haven't tried one yet.

codex is planned. there is no date.

the queue itself doesn't care who sends. it is a folder of plain files, and the `bateson` command works from any shell. bateson's hooks do nothing unless claude code started them, so other tools that read claude code's settings are left alone.

if you want to build an integration for another agent, start with [`docs/other-agents.md`](./docs/other-agents.md), a dated snapshot of what codex, cursor, opencode and six others can and cannot do. a PR is welcome. it lives in its own folder, marked with your name and the date and version you tested on, and is listed as from the community. if it breaks and nobody fixes it, it is removed.

## how it works

an agent runs `bateson send`. a hook waits in the background for your response and wakes that session with it. claude code stops a hook after four hours, so just before then the hook wakes the agent to renew the wait, for up to a day. if nothing is waiting any more, that session gets it on your next prompt there, or, once it has ended, the next session in that repository.

[`docs/concept.md`](./docs/concept.md) explains what bateson is for. [`docs/folder-format.md`](./docs/folder-format.md) is the contract on disk, if you want to send from something else.

## changing it

the skills are plain markdown. if you want agents to ask you differently, edit [`skill/bateson/SKILL.md`](./skill/bateson/SKILL.md). the install links to it, so the change is live in the next session.

[`docs/reference.md`](./docs/reference.md) has the keys, the settings, what each part of the code does, and how to run it against a scratch queue while you work on it.

## uninstall

```bash
node scripts/install.ts --uninstall
```

this removes the command, the skills, the hooks and the login item, and puts back your `grilling` skill if the installer swapped it. `~/.claude/settings.json` comes back as it was before the install. the copies the installer kept of it (`settings.json.bak-bateson-…`) stay next to it, and so does your queue in `~/.bateson`. delete them if you want them gone.

## license

MIT, see [LICENSE](LICENSE).

asking in rounds grew out of matt pocock's `grilling` skill. thank you, matt.

named after gregory bateson, who saw a mind as a loop that includes the things it works on.

the fonts in `web/public/fonts/` (schibsted grotesk, newsreader, ibm plex mono) are under the SIL open font license 1.1, and their licenses are next to them.
