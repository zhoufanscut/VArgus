---
name: vargus-setup
description: Set up, check or remove the VArgus status line, the statusLine entry in Claude Code settings that prints the line the vargus plugin writes. Use when asked to set up, install, fix or remove the VArgus status line, or before uninstalling the vargus plugin.
---

# VArgus status line setup

The vargus plugin's mod writes the status line to a file; Claude Code shows it through a
`statusLine` command that prints that file. A plugin can't set `statusLine` itself, so this
skill edits the person's settings once.

The reader command for this install, with this plugin's data folder already filled in:

```sh
cat "${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line" 2>/dev/null
```

With the plugin's `blankStopped` option on, the reader instead prints the file only while it is
under two minutes old, so the row goes blank when the plugin stops mid-session:

```sh
f="${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line"; [ -n "$(find "$f" -mmin -2 2>/dev/null)" ] && cat "$f"
```

`$CLAUDE_CODE_SESSION_ID` and `$f` stay as written: the shell fills them in when Claude Code runs
the command.

## Set up

0. On Windows (the session's platform is `win32`, or the data folder above starts with a drive
   letter such as `C:`), check for Git Bash before changing anything: Claude Code runs the
   `statusLine` command through Git Bash when it is installed, else through PowerShell, where
   these readers fail and the row stays blank. Claude Code gives the session a Bash tool only
   when it found Git Bash, so that is the check: with no Bash tool (only PowerShell), tell the
   person VArgus on Windows needs Git for Windows (https://git-scm.com/downloads/win): install
   it, restart Claude Code, then ask for setup again. Stop there, with the settings unchanged.
   Don't run `bash` from PowerShell to check: with WSL installed that starts WSL's bash, which
   has `cat` and `find` while Claude Code still has no Git Bash. With a Bash tool, run `command
   -v cat find` in it. If either is missing, say so, and stop with the settings unchanged. If
   both are found, go on, and in step 3 write the data folder with `/` in place of each `\`
   (`C:/Users/...`): Git Bash drops unquoted backslashes, and JSON would need each one escaped.
   VArgus has been tested on one Windows 11 machine only.
1. Pick the settings file by how the plugin is installed. Run `claude plugin list --json` and
   read the `vargus@...` entries' `scope` and `projectPath` (the list also shows local installs
   of other projects; the one for this project has `enabled: true`).
   - Installed from a marketplace not named `vargus` (the id is not `vargus@vargus`): the mod
     writes its line under `vargus-vargus` while the reader below would name another folder, so
     the row would stay blank. Tell the person to install from this repo's own marketplace
     (`zhoufanscut/VArgus`, or a clone of it), and stop.
   - Installed at `user` scope: the reader goes in the user settings file,
     `$CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json` when `CLAUDE_CONFIG_DIR` is
     unset. The line then shows in every project.
   - Installed only at `project` or `local` scope: the mod runs only in that project, so a reader
     in the user settings file would leave the status line blank in every other project. Tell
     the person so, and offer two ways: install at user scope (`claude plugin install
     vargus@vargus --scope user`, then this step again), or put the reader in
     `<projectPath>/.claude/settings.local.json` (per person and not committed, also for a
     `project` install, since the reader names a folder in this person's home). Go on with the
     file they pick.

   Read the chosen file; it may not exist yet. Pick the reader: the second one when
   `pluginConfigs["vargus@vargus"].options.blankStopped` is `true` in the user settings file,
   else the first (the option is off by default).
2. If its `statusLine` command is already the picked reader, say so and stop. If it is another
   VArgus reader (as Remove step 1 recognises one: the other reader, or another folder), replace
   it without asking and keep no copy. If it has any other `statusLine` entry, show it to the
   person and ask before replacing it; when the chosen file is the user settings file, offer to
   keep a copy in `statusLine.before-vargus.json` beside it, so it can be put back later (not in
   the data folder: uninstalling deletes that). Never overwrite an existing
   `statusLine.before-vargus.json`: it holds the entry from before VArgus; keep the copy under a
   new name instead (`statusLine.before-vargus.2.json`) and tell the person where it is.
3. Set `statusLine` to the entry below for the picked reader, changing nothing else in the
   file. In JSON the command's inner quotes are escaped:

   ```json
   "statusLine": {
     "type": "command",
     "command": "cat \"${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line\" 2>/dev/null",
     "refreshInterval": 1
   }
   ```

   With `blankStopped` on:

   ```json
   "statusLine": {
     "type": "command",
     "command": "f=\"${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line\"; [ -n \"$(find \"$f\" -mmin -2 2>/dev/null)\" ] && cat \"$f\"",
     "refreshInterval": 1
   }
   ```

4. With the reader in the user settings file, check the current project's
   `.claude/settings.json` and `.claude/settings.local.json`: a `statusLine` there replaces the
   user's in that project. If one exists, tell the person; change it only if they ask.
   With the reader in a project's `.claude/settings.local.json`, check the user settings file for
   a VArgus reader (as Remove step 1 recognises one), left by an earlier setup: it blanks the row
   in every other project. If there is one, offer to remove it, putting back the entry kept in
   `statusLine.before-vargus.json` if there is one and the person wants it.
5. Tell the person the line shows from the next status-line run, within about two seconds of the
   next reply. A folder whose workspace trust is not yet accepted shows no status line.

## Remove (before uninstalling)

1. A VArgus reader is a `statusLine` whose command names
   `.../vargus-vargus/$CLAUDE_CODE_SESSION_ID/line` (either reader above), whatever the folder
   before it is spelled as (the README's by-hand entries write `$HOME/.claude/...`). Look in the
   user settings file and in the current project's `.claude/settings.json` and
   `.claude/settings.local.json`.
2. Remove the `statusLine` entry from the user settings file and from
   `.claude/settings.local.json`, changing nothing else. Ask before changing the project's
   `.claude/settings.json`: it is usually committed and shared. In the user settings file, put
   back the entry kept in `statusLine.before-vargus.json` if there is one and
   the person wants it.
3. Tell the person they can now uninstall: `claude plugin uninstall vargus@vargus --scope
   <scope>` for each scope `claude plugin list --json` shows (the command's default is `user`),
   or remove it in `/plugin` under **Installed**. Uninstalling deletes the plugin's data folder,
   so a reader left in settings would show a blank row.
