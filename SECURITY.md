# security

bateson runs on your machine, and an answer in it becomes an instruction to an agent. so a hole in it can matter more than the size of the project suggests.

## reporting

please don't open a public issue for a security problem. report it privately instead: on the repository's **Security** tab, choose **Report a vulnerability**. only i see it there.

say what you did, what happened, and which version (`git rev-parse HEAD` in your bateson folder) and system you ran it on. i'll answer within a week, and tell you when a fix is on `main`.

## what counts

for example:

- a web page, or another account on the same machine, that can read your queue, answer for you or start an update.
- a file an agent attaches that runs as a page on bateson's address.
- the installer or uninstaller changing more in `~/.claude` than it says it does.

## versions

only the latest `main` gets fixes. **update** in settings installs it.
