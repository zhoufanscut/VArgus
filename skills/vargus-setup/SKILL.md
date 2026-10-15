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

1. The user settings file is `$CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json`
   when `CLAUDE_CONFIG_DIR` is unset. Read it; it may not exist yet.
2. If its `statusLine` command is already the reader command above, say so and stop. If it has
   another `statusLine` entry (an older VArgus reader with another folder included), show it to the person and ask before replacing it. Offer to keep
   a copy in `statusLine.before-vargus.json` beside the settings file, so it can be put back
   later (not in the data folder: uninstalling deletes that).
3. Set `statusLine` to the entry below, changing nothing else in the file. In JSON the
   command's inner quotes are escaped:

   ```json
   "statusLine": {
     "type": "command",
     "command": "cat \"${CLAUDE_PLUGIN_DATA}/$CLAUDE_CODE_SESSION_ID/line\" 2>/dev/null",
     "refreshInterval": 1
   }
   ```

4. Check the current project's `.claude/settings.json` and `.claude/settings.local.json`: a
   `statusLine` there replaces the user's in that project. If one exists, tell the person; change
   it only if they ask.
5. Tell the person the line shows from the next status-line run, within about a second of the
   next reply. A folder whose workspace trust is not yet accepted shows no status line.

## Remove (before uninstalling)

1. A VArgus reader is a `statusLine` whose command `cat`s
   `.../vargus-vargus/$CLAUDE_CODE_SESSION_ID/line`, whatever the folder before it is spelled as
   (the README's by-hand entry writes `$HOME/.claude/...`). Look in the user settings file and in
   the current project's `.claude/settings.json` and `.claude/settings.local.json`.
2. Remove the `statusLine` entry from the user settings file and from
   `.claude/settings.local.json`, changing nothing else. Ask before changing the project's
   `.claude/settings.json`: it is usually committed and shared. In the user settings file, put back the entry kept in `statusLine.before-vargus.json` if there is one and
   the person wants it.
3. Tell the person they can now uninstall (`claude plugin uninstall vargus`). Uninstalling
   deletes the plugin's data folder, so a reader left in settings would show a blank row.
