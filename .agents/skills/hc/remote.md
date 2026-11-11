# Remote machines and files

See [SKILL.md](SKILL.md) for collaboration and [install.md](install.md) for local setup.

## Other machines and files

Your harness's own file tools touch only the machine you run on. Use hc for
remote files and commands. `hc machine ls` lists configured machines; see
`hc machine --help` to configure SSH or `--via <cmd>` connections.
Without `--name`, SSH machines use the first host label (IPs stay whole),
shortened to 32 characters with `-2`, `-3`, etc. added if the name is taken.

On Windows, `hc server status` never starts a core. If elevated SSH startup
would block the same user's desktop session, open Herdr on that Windows
machine or run `hc server start` in a normal desktop terminal, then reconnect.
Headless Windows machines can still start their core over SSH.
New Windows terminals refresh user/system environment settings, including PATH.

```sh
hc run --on vps --cwd /srv/app cargo test    # returns vps/t3; use that full address
hc run --bg --on vps --cwd /srv/app cargo build
hc exec --on vps --cwd /srv/app git diff    # short command, exact output, no terminal
hc file read --on vps /srv/app/src/x.rs --offset 200 --limit 100
hc file edit --on vps /srv/app/src/x.rs --old 'exact text' --new 'replacement'
hc file write --on vps /srv/app/src/y.rs < content.txt
```

`exec -i` feeds piped input to the command. File writes replace the whole
file and create parent folders. Edits require the old text exactly once;
`edit_failed` means add enough context to make it unique. Repeat `--old` and
`--new` pairs for multiple changes; all succeed or none do. No remote shell
text rewriting needed: only the edit travels.
Remote paths start at that machine's home unless you set `--cwd`; local
paths start at your current folder. Prefer explicit paths for remote work.


For exact machine setup options, run `hc machine add --help`; `hc machine login`, `update`, `rename`, and `rm` manage existing connections. `rm` forgets a machine locally without stopping its remote terminals. `--install` on `machine add` copies hc when absent or too old.
