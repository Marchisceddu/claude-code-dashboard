# Claude Code Dashboard

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that keeps a pane beside the chat with three tabs:

- **Changes**: the files every message of the chat changed, newest message first, one section per message, grouped by folder. A file's name is a link: in a VS Code-family editor (Antigravity, VS Code, Cursor, VSCodium) it opens the diff view between the file before the message and after it, added lines in green and removed in red; other editors open the file at its first change. The green `+added` and red `−removed` counts show or hide the file's hunks right below it.
- **To copy**: every block between ``` in Claude's answers (commands, emails, snippets), shown in full and separated. Each gets a key, `1`–`9`, that puts it on the clipboard.
- **Files**: the session's root folder as a tree, like an editor's explorer. Folders first; a click opens or closes a folder, or opens a file in your editor. Names are coloured by git status (`M` yellow, `U`/`A` green, `R` blue) and by the files this chat changed; a folder holding changes gets a `•`. `.git` and `.DS_Store` are hidden; a folder shows its first 400 entries. The tree is read again when you open the tab, at the end of every message, and with `refresh`.

The pane minimises to one line above the prompt and reopens from there.

## Install

In a Claude Code terminal session:

```
/plugin install dashboard --marketplace Marchisceddu/claude-code-dashboard
```

From a shell:

```
claude plugin install dashboard --marketplace Marchisceddu/claude-code-dashboard
```

The pane opens in the next session. `/dashboard` opens it at any time.

## Use

Focus the pane with `ctrl+x tab` (or click), then:

| Key | Does |
|---|---|
| `m` | Changes tab |
| `c` | To copy tab |
| `f` | Files tab |
| `a` | refresh the tree (Files tab) |
| `1`–`9` | copy that text (To copy tab) |
| `r` | minimise to one line above the prompt |
| `d` | reopen, from the minimised line |

The ✕ on the pane's frame closes it. Open, minimised or closed is remembered for the next session.

**What counts as a text to copy.** Every fenced block (```` ``` ```` or `~~~`, any language) in Claude's answers. Each one is shown in full, with syntax highlighting for its language, under a header with its key and language, and a rule separates one block from the next. A block whose language is `copy` can carry a label, which then replaces the language in the header:

````
```copy Email to the client
Hi Luca, …
```
````

The mod teaches Claude the `copy` label with one short paragraph in the system prompt. The tab lists the blocks of the whole chat, newest first, read again from the transcript at the end of every message (a resumed chat brings its blocks back). The newest 60 are kept; the newest 9 get the keys `1`–`9`, the rest are copied with a click.

## Options

`/plugin` → dashboard → configure:

| Option | Default | |
|---|---|---|
| `language` | `auto` | Labels: `en`, `it`, or `auto` (Claude Code's `language` setting, else the system locale, else English) |
| `editor` | empty | Command that opens a file, with `{file}` and `{line}`, e.g. `code -g {file}:{line}` or `subl {file}:{line}`. Use double quotes around a path with spaces. Empty: the VS Code-family editor the session runs in (Antigravity, VS Code, Cursor, VSCodium), else the first one installed, else `open` (macOS) / `xdg-open` (Linux) |

## How it works

- Before and after each `Edit`, `Write` and `NotebookEdit` (subagents' included) it reads the file and keeps the lines added and removed and one diff hunk per edit. Files deleted through a shell command are not tracked.
- For the editor's diff view it writes two copies per file and message to the system's temporary folder (`$TMPDIR/claude-dashboard/<session id>/`): the file before the message's first edit and after its latest. The right side of the diff is the file itself when nothing changed it since, so you can edit it there; otherwise the copy.
- At the end of each message it reads the chat's assistant messages and collects their fenced blocks.
- Everything else stays in the session's memory: no network, no model calls, nothing written to your project. The only thing it adds to the context is the `copy` paragraph in the system prompt (about 80 tokens).

Claude Code's built-in `/diff` (fullscreen) also shows uncommitted changes and per-turn diffs from git. This mod works outside git repositories too, opens files in the editor, and adds the To copy tab.

## Limits

- The terminal docks the pane on the right of the chat; the side can't be chosen by a mod.
- Line counts and diffs compare the file before and after each edit: one hunk per edit, not a minimal diff of the whole message. The last 30 messages are kept.

## Develop

```
claude plugin validate plugins/dashboard
claude plugin test plugins/dashboard
```

To run your working copy: `claude plugin marketplace add <path to this repo>`, then `claude plugin install dashboard@claude-code-dashboard`. Claude Code then reads the plugin from the folder itself: after an edit, `/reload-plugins` in a session.

## License

MIT
