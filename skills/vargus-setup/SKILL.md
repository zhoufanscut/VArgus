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

`$CLAUDE_CODE_SESSION_ID` stays as written: Claude Code sets it when it runs the command.

## Set up

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

   Read the chosen file; it may not exist yet.
2. If its `statusLine` command is already the reader command above, say so and stop. If it has
   another `statusLine` entry (an older VArgus reader with another folder included), show it to
   the person and ask before replacing it. When the chosen file is the user settings file, offer
   to keep a copy in `statusLine.before-vargus.json` beside it, so it can be put back later (not
   in the data folder: uninstalling deletes that).
3. Set `statusLine` to the entry below, changing nothing else in the file. In JSON the
   command's inner quotes are escaped:

   ```json
   "statusLine": {
     "type": "command",
     "command": "cat \"${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line\" 2>/dev/null",
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

1. A VArgus reader is a `statusLine` whose command `cat`s
   `.../vargus-vargus/$CLAUDE_CODE_SESSION_ID/line`, whatever the folder before it is spelled as
   (the README's by-hand entry writes `$HOME/.claude/...`). Look in the user settings file and in
   the current project's `.claude/settings.json` and `.claude/settings.local.json`.
2. Remove the `statusLine` entry from the user settings file and from
   `.claude/settings.local.json`, changing nothing else. Ask before changing the project's
   `.claude/settings.json`: it is usually committed and shared. In the user settings file, put
   back the entry kept in `statusLine.before-vargus.json` if there is one and
   the person wants it.
3. Tell the person they can now uninstall: `claude plugin uninstall vargus@vargus --scope
   <scope>` for each scope `claude plugin list --json` shows (the command's default is `user`),
   or remove it in `/plugin` under **Installed**. Uninstalling deletes the plugin's data folder,
   so a reader left in settings would show a blank row.
