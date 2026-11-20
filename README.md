# VArgus

VArgus shows context use, rate limits with reset countdowns, token and call
counts, and repository status in Claude Code, OmO Native, Antigravity CLI and
Codex CLI. The hosts share a renderer and colour themes.

## Choose your setup

| Host | Where it appears | Standard install |
|---|---|---|
| [Claude Code](docs/setup-claude.md) | Under the prompt | `vargus install claude` |
| [OmO Native](docs/setup-omo.md) | Below the editor | `vargus install omo` |
| [Antigravity CLI](docs/setup-antigravity.md) | Under the prompt | `vargus install antigravity` |
| [Codex CLI](docs/setup-codex.md) | In a tmux or psmux row | `vargus install codex` for startup hooks |

Use the [shared checkout and launcher](#shared-checkout-and-launcher) for these
commands. The launcher uses Node.js 24.12 or later and runs directly from source.
User installs need no npm install or build.
The host guides include verification and removal steps, plus
[manual Claude setup without Node.js](docs/setup-claude.md#manual-setup-without-nodejs)
and [manual Codex activation](docs/setup-codex.md#manual-activation).

For agent-assisted setup, name the guide and the target home or project.

> Read `docs/setup-codex.md` from this VArgus checkout. Set up VArgus for my
> current Codex home, including the `vargus` PATH launcher and startup hooks.

## Shared checkout and launcher

Reuse one VArgus checkout for Codex, Antigravity CLI, OmO and a Claude directory
marketplace. Use its absolute path in each setup. Clone VArgus if you need a checkout.

```sh
mkdir -p "$HOME/.local/share"
git clone https://github.com/zhoufanscut/VArgus "$HOME/.local/share/VArgus"
```

On Windows, clone to a location such as `%USERPROFILE%\.local\share\VArgus`.
Read the guide from the checkout or release tag you will run. Use `./bin/vargus --help`
on Linux or macOS, or `.\bin\vargus.cmd --help` in PowerShell, to check that checkout's
commands. For example, [v0.6.0](https://github.com/zhoufanscut/VArgus/blob/v0.6.0/README.md)
uses `vargus omo install` and `vargus omo remove`.

### Shared configuration

To customize VArgus for the hosts using this checkout, copy
[`vargus.sample.jsonc`](vargus.sample.jsonc) to `vargus.jsonc` beside this README.
From the checkout root, run `cp vargus.sample.jsonc vargus.jsonc` or, in
PowerShell, `Copy-Item vargus.sample.jsonc vargus.jsonc`. Git ignores your copy.

The example explains each option and lists the available themes. Uncomment the
settings you want and change their values. The file accepts ordinary JSON plus
`//` and `/* … */` comments. VArgus starts with its built-in defaults and reads
the file from its own checkout, wherever you start the host.

- **Claude Code** shows shared values in the VArgus section of `/config`.
  Changing a picker option saves it to the shared file, creating the file on
  the first change in a clone. After editing the file by hand, run
  `/reload-plugins` or open a new session. [Claude guide](docs/setup-claude.md#configure)
- **Codex** reads the file on activation and on `!vargus reload`. An explicit
  `--config FILE` or `--theme NAME` overrides the corresponding shared values.
  [Codex guide](docs/setup-codex.md#configure)
- **OmO Native** reads it when the extension loads. Run `/reload` after an edit.
  An install-time `--config FILE` overrides shared values, and
  `/vargus config` overrides them for that session. [OmO guide](docs/setup-omo.md#configure)
- **Antigravity CLI** reads it on the next status-line refresh. Flags on the
  status-line command override the corresponding shared values.
  [Antigravity guide](docs/setup-antigravity.md#configure)

### Put vargus on PATH

The host installers and the Codex and Antigravity CLI commands share a single
launcher. Inspect any existing `vargus` on PATH and reuse it if it points to the
intended checkout. Preserve unrelated commands. On Linux or macOS, create a symlink
in a directory on your PATH if you need a launcher.

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$HOME/.local/share/VArgus/bin/vargus" "$HOME/.local/bin/vargus"
```

Use your checkout's absolute `bin/vargus` path if it differs. On Windows, put a
forwarding file named `vargus.cmd` in a user PATH directory such as
`%USERPROFILE%\.local\bin`:

```bat
@echo off
"H:\VArgus\bin\vargus.cmd" %*
```

Replace the example path with your checkout's absolute path.
Add the directory to your user PATH if needed, reopen your terminal, and check
`vargus --help`. Use `vargus install --help` or `vargus remove --help` to see the
supported hosts and options.

### Remove shared files

After removing the host integration, check these paths separately.

1. Keep the PATH launcher while Codex controls or hooks, Antigravity's
   `statusLine`, or any other command uses that launcher. Once it is unused,
   verify it is the VArgus launcher you installed with
   `readlink "$HOME/.local/bin/vargus"` on Linux or macOS, or inspect the
   forwarding `vargus.cmd` on Windows. Remove that file and leave the PATH directory.
2. Keep the checkout while it is used by a launcher, a hook or status-line
   command pointing directly into it, an [OmO loader](docs/setup-omo.md#install), or a
   [Claude directory marketplace](docs/setup-claude.md#or-from-a-clone-updated-with-git-pull).
   After removing the remaining integrations that reference that checkout and
   reloading or closing their sessions as directed, you can delete the checkout.
   Copy `vargus.jsonc` elsewhere first if you want to keep your settings.

## What it shows

Illustrative output from Claude Code.

```
~/proj/VArgus | opus:high | 5h:4%(4h37m) 7d:39%(5d6h) | ctx:20% | token:69.5k | session:24m | 🔧73 🤖2 ⚡1 | repo:VArgus | branch:main | ?4
```

| Fragment | What it is |
|---|---|
| `~/proj/VArgus` | the working folder |
| `opus:high` / `carbon:high` / `sol:xhigh` | the model and effort level |
| `5h:` `7d:` `1m:` | rate-limit windows with used percent and time until reset. `1m` is Kimi Code's membership monthly total. |
| `ctx:` | how full the context window is |
| `token:` | uncached input plus output tokens in the scope described by the host guide |
| `session:` | age of the session or active conversation |
| `🔧` `🤖` `⚡` | tool, agent and skill counts described in the host guides |
| `repo:` `branch:` | Git repository and branch. On a detached HEAD, the label shows the checkout ref or short commit ID. During a rebase it shows the branch being rebased when available. Claude Code also supports SVN. |
| `?4` | Working-tree marks include staged `+`, modified `!`, untracked `?`, conflicts `✗`, ahead `⇡`, and behind `⇣`. |

Effort uses the selected theme's Calm colour at or above the model's default
and Alert below it. When the default is unavailable, `high` is the cutoff.
Effort values that cannot be compared use Alert. Codex reads the configured
model catalog or its local cache, OmO uses the active model's metadata, and
Claude Code and Antigravity use published defaults for recognised models.

Each fragment has a switch. Open the guide for your host to configure the line
and see how that host counts tokens, tools, agents and skills.

## Development

See [AGENTS.md](AGENTS.md) for working rules,
[development checks](docs/maintenance.md#development-checks) for test commands,
and [DESIGN.md](DESIGN.md) for implementation and verification limits.
[CHANGELOG.md](CHANGELOG.md) records what shipped in each release.
