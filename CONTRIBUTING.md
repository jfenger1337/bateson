# contributing

bateson is a one-person tool that other people can use. fork it and make it yours. a PR is welcome when the change would help someone else too.

## run a copy that leaves your own queue alone

```bash
git clone https://github.com/jfenger1337/bateson.git && cd bateson
npm ci
BATESON_HOME=/tmp/bateson-dev BATESON_PORT=4849 npm start
```

this starts a server on its own queue and port. in a second terminal, `BATESON_HOME=/tmp/bateson-dev BATESON_PORT=4849 npm run dev` serves the app on http://localhost:5848 with live reload, and `BATESON_HOME=/tmp/bateson-dev BATESON_PORT=4849 node cli/bateson.ts send ...` puts items in that queue.

[`docs/reference.md`](./docs/reference.md) says what each part of the code does.

## before you open a PR

- `npm run build` passes. it typechecks the server, the command and the app, then builds the app. every PR runs it too.
- there are no tests. say in the PR how you tried the change: what you sent, what you clicked, what happened.
- if you changed the installer, run it with `HOME` set to a scratch folder, then run it again with `--uninstall`, and check that the settings file came back as it was.
- if you changed something on screen, add a screenshot.

## integrations for other agents

start with [`docs/other-agents.md`](./docs/other-agents.md), a dated snapshot of what each agent can and cannot do. an integration:

- lives in its own folder, with your name and the date and agent version you tested it on.
- is listed in the README as from the community.
- is removed if it breaks and nobody fixes it.

bateson only calls an agent supported when it is woken by your answer, the way Claude Code is. an integration that has to wait for the answer instead says so.
