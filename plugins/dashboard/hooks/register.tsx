// Dashboard: a pane beside the chat with two tabs.
//   Changes: the files every message of the chat changed (Edit, Write, NotebookEdit, subagents' too), newest message
//            first, one section each, files grouped by folder. A file's name is a link: it opens the editor's diff
//            view (VS Code family: `--diff`, lines added in green, removed in red) between the file before the message
//            and after it; other editors open the file at its first change. The +added −removed counts (green, red)
//            show or hide that file's hunks below it.
//   To copy: every fenced block (```) of the chat's answers, newest first, shown in full and separated; a click
//            or a key (1-9, the newest nine) puts it on the clipboard. ```copy blocks may carry a label after `copy`.
//   Files: the session's root folder as a tree, as an editor's explorer shows it: folders first, opened and closed
//            with a click, a file opens in the editor. Names are coloured by git status (M yellow, U/A green, R blue)
//            and by this chat's edits; a folder holding changes gets a dot. Refreshed at the end of every message.
// The pane minimises to one line above the prompt (riduci/minimise) and closes with the frame's own ✕.
// Options (/plugin → dashboard → configure): `language` (auto, en, it) and `editor` (a command with {file} and {line}).
// Language auto: Claude Code's `language` setting, else the system locale; English when neither is Italian.
// The model learns the ```copy convention from one short system-prompt section; nothing else enters the context.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { DirList, Editor, FileChange, Lang, Mode, Snippet, TreeEntry, Turn, View } from '../types'

const PANE = 'dashboard'
const TITLE = 'Dashboard'
const COLUMNS = 46
const KEEP_TURNS = 30
const KEEP_COPIES = 60
const HOTKEYS = 9
const CONTEXT = 3
const MAX_DIFF_CHARS = 12_000
const MAX_ENTRIES = 400 // per folder
const MAX_ROWS = 2_000 // in the whole tree
const HIDDEN = new Set(['.git', '.DS_Store'])
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
const MODE_KEY = 'mode' // $.store: these choices outlive the session
const VIEW_KEY = 'view'

const turns = atom({ plugin: 'dashboard', key: 'turns' } as const, [] as Turn[], { shape: 'turns-4' })
const copies = atom({ plugin: 'dashboard', key: 'copies' } as const, [] as Snippet[], { shape: 'copies-2' })
const cwdAtom = atom({ plugin: 'dashboard', key: 'cwd' } as const, '')
// open: the pane; mini: one line above the prompt that reopens it; closed: nothing until /dashboard.
const modeAtom = atom({ plugin: 'dashboard', key: 'mode' } as const, 'open' as Mode)
const viewAtom = atom({ plugin: 'dashboard', key: 'view' } as const, 'changes' as View)
// The files whose hunks are shown, as `turnId|path`.
const expandedAtom = atom({ plugin: 'dashboard', key: 'expanded' } as const, [] as string[], { shape: 'expanded-1' })
// Where the before/after copies of edited files go: <TMPDIR>/claude-dashboard/<session id>.
// Files tab: the root, each listed folder's entries, the open folders, the git status by path, the file last opened.
const rootAtom = atom({ plugin: 'dashboard', key: 'root' } as const, '')
const treeAtom = atom({ plugin: 'dashboard', key: 'tree' } as const, {} as Record<string, DirList>, { shape: 'tree-1' })
const openDirsAtom = atom({ plugin: 'dashboard', key: 'openDirs' } as const, [] as string[], { shape: 'open-dirs-1' })
const gitAtom = atom({ plugin: 'dashboard', key: 'git' } as const, {} as Record<string, string>, { shape: 'git-1' })
const treeSelAtom = atom({ plugin: 'dashboard', key: 'treeSel' } as const, '')
const snapAtom = atom({ plugin: 'dashboard', key: 'snap' } as const, '')
const langAtom = atom({ plugin: 'dashboard', key: 'lang' } as const, 'it' as Lang)
const editorAtom = atom({ plugin: 'dashboard', key: 'editor' } as const, { name: '', template: '', diff: '' } as Editor, { shape: 'editor-3' })

// Editors a file opens in, VS Code family (`<cli> -g file:line`). The session's own editor wins: on macOS the app
// it runs in (bundle id), on Linux a VS Code-family terminal (TERM_PROGRAM=vscode). Else the first one found.
export const EDITORS: readonly { name: string; bundleId: string; mac: string; bin: string }[] = [
    { name: 'Antigravity IDE', bundleId: 'com.google.antigravity-ide', mac: '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide', bin: 'antigravity-ide' },
    { name: 'Antigravity', bundleId: 'com.google.antigravity', mac: '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity', bin: 'antigravity' },
    { name: 'VS Code', bundleId: 'com.microsoft.VSCode', mac: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', bin: 'code' },
    { name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', mac: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor', bin: 'cursor' },
    { name: 'VSCodium', bundleId: 'com.vscodium', mac: '/Applications/VSCodium.app/Contents/Resources/app/bin/codium', bin: 'codium' },
]

// One shell call at session start: the platform, the app the session runs in, its locale, the editor CLIs on PATH,
// the temporary folder (a `tmp=` line).
const PROBE =
    'printf "%s\\n" "$(uname -s)" "${__CFBundleIdentifier:-}" "${TERM_PROGRAM:-}" "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" ' +
    '"$(defaults read -g AppleLocale 2>/dev/null)"; for b in ' + EDITORS.map(x => x.bin).join(' ') + '; do command -v "$b"; done; printf "tmp=%s\\n" "${TMPDIR:-/tmp}"; true'

const CONVENTION =
    'When your answer contains text the user will copy and paste elsewhere (a message, an email, a reply, a ' +
    'command to run in another terminal, a value), put that text in a fenced block whose language is `copy`, ' +
    'optionally followed by a short label: ```copy Email to the client. The block appears in the Dashboard pane ' +
    'with a key to copy it. Use it only for text meant to be pasted, not for code you write to files.'

const LABELS = {
    it: {
        changes: 'Modifiche', toCopy: 'Da copiare', files: 'File', refresh: 'aggiorna', collapse: 'comprimi',
        more: 'altri', emptyDir: '(vuota)', noRoot: 'Cartella non leggibile.', minimise: 'riduci', open: 'apri',
        noMessage: 'Ancora nessun messaggio.', noFiles: 'nessun file modificato', message: '(messaggio)',
        isNew: 'nuovo', total: 'totale',
        diffTooBig: 'diff troppo grande da mostrare', noDiff: 'nessuna differenza di testo',
        pressFile: 'nome: apre le differenze nell\'editor · +/−: mostra le righe',
        noCopies: 'Qui finiscono, interi, i blocchi tra ``` delle risposte di Claude.',
        copy: 'copia', copied: 'Copiato', notCopied: 'Non sono riuscito a copiare', untouched: 'nessun file toccato',
        toCopyCount: 'da copiare', diffIn: 'Differenze aperte in', openedIn: 'Aperto in', notOpened: 'Non sono riuscito ad aprire', opened: 'Dashboard aperta: ctrl+x tab per entrarci; m modifiche, c da copiare, 1-9 copia, r riduce.',
    },
    en: {
        changes: 'Changes', toCopy: 'To copy', files: 'Files', refresh: 'refresh', collapse: 'collapse',
        more: 'more', emptyDir: '(empty)', noRoot: 'Folder not readable.', minimise: 'minimise', open: 'open',
        noMessage: 'No message yet.', noFiles: 'no file changed', message: '(message)',
        isNew: 'new', total: 'total',
        diffTooBig: 'diff too large to show', noDiff: 'no text difference',
        pressFile: 'name: opens the differences in the editor · +/−: shows the lines',
        noCopies: "The ``` blocks of Claude's answers land here, in full.",
        copy: 'copy', copied: 'Copied', notCopied: 'Could not copy', untouched: 'no file changed',
        toCopyCount: 'to copy', diffIn: 'Differences opened in', openedIn: 'Opened in', notOpened: 'Could not open', opened: 'Dashboard open: ctrl+x tab to enter it; m changes, c to copy, 1-9 copies, r minimises.',
    },
} as const

// ---------- pure helpers (tested) ----------

export type Probe = { os: string; bundleId: string; termProgram: string; locale: string; appleLocale: string; onPath: string[]; tmp: string }

export function parseProbe(out: string): Probe {
    const [os = '', bundleId = '', termProgram = '', locale = '', appleLocale = '', ...rest] = out.split('\n')
    const lines = rest.map(l => l.trim()).filter(Boolean)
    const tmp = (lines.find(l => l.startsWith('tmp='))?.slice(4) || '/tmp').replace(/\/+$/, '')
    return { os, bundleId, termProgram, locale, appleLocale, onPath: lines.filter(l => !l.startsWith('tmp=')), tmp }
}

/** Labels language: the option, else Claude Code's `language` setting, else the system locale; English by default. */
export function langOf(option: unknown, setting: unknown, probe?: Pick<Probe, 'locale' | 'appleLocale'>): Lang {
    const pick = (v: unknown): Lang | null =>
        typeof v !== 'string' ? null : /^\s*(it|ital)/i.test(v) ? 'it' : /^\s*(en|eng|ingl)/i.test(v) ? 'en' : null
    if (option === 'it' || option === 'en') return option
    const locale = probe && !/^(C|POSIX)?(\.|$)/i.test(probe.locale) ? probe.locale : ''
    return pick(setting) ?? pick(locale) ?? pick(probe?.appleLocale) ?? 'en'
}

/** Splits an editor template into argv: whitespace-separated, "double quotes" keep spaces, {file} and {line} filled. */
export function editorArgv(template: string, file: string, line: number, before = '', after = ''): string[] {
    const parts = template.match(/"[^"]*"|\S+/g) ?? []
    return parts.map(p =>
        p.replace(/^"(.*)"$/, '$1').replaceAll('{file}', file).replaceAll('{line}', String(line))
            .replaceAll('{before}', before).replaceAll('{after}', after),
    )
}

/** Where a file's copies before and after one message go: one folder per message and file, the file's own name kept. */
export function snapPaths(base: string, turnId: number, path: string): { before: string; after: string } {
    let h = 5381
    for (let i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0
    const name = path.split('/').pop() || 'file'
    const dir = `${base}/m${turnId}/${h.toString(16)}`
    return { before: `${dir}/before/${name}`, after: `${dir}/after/${name}` }
}

/** The editor files open with: the `editor` option, else the session's own VS Code-family editor, else the first found. */
export function pickEditor(option: unknown, probe: Probe, exists: (path: string) => boolean): Editor {
    if (typeof option === 'string' && option.trim()) {
        const cmd = option.trim().match(/^"[^"]*"|^\S+/)?.[0] ?? ''
        const base = cmd.replace(/"/g, '').split('/').pop() ?? ''
        const isVsFamily = EDITORS.some(x => x.bin === base)
        return { name: base || 'editor', template: option.trim(), diff: isVsFamily ? `${cmd} --diff {before} {after}` : '' }
    }
    const isMac = probe.os === 'Darwin'
    const cliOf = (x: (typeof EDITORS)[number]) =>
        isMac ? (exists(x.mac) ? x.mac : null) : (probe.onPath.find(p => p.endsWith('/' + x.bin)) ?? null)
    const own = isMac ? EDITORS.find(x => x.bundleId === probe.bundleId) : undefined
    for (const x of own ? [own, ...EDITORS] : EDITORS) {
        const cli = cliOf(x)
        if (cli) return { name: x.name, template: `"${cli}" -g {file}:{line}`, diff: `"${cli}" --diff {before} {after}` }
    }
    return isMac ? { name: 'macOS', template: '/usr/bin/open {file}', diff: '' } : { name: 'xdg-open', template: 'xdg-open {file}', diff: '' }
}

/** Lines added and removed between two texts: common head and tail trimmed, the middle compared as multisets. */
export function lineDiff(before: string | null, after: string | null): { added: number; removed: number } {
    const a = before === null || before === '' ? [] : before.split('\n')
    const b = after === null || after === '' ? [] : after.split('\n')
    let head = 0
    while (head < a.length && head < b.length && a[head] === b[head]) head++
    let tail = 0
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
    const midA = a.slice(head, a.length - tail)
    const midB = b.slice(head, b.length - tail)
    const counts = new Map<string, number>()
    for (const l of midA) counts.set(l, (counts.get(l) ?? 0) + 1)
    let common = 0
    for (const l of midB) {
        const c = counts.get(l) ?? 0
        if (c > 0) {
            counts.set(l, c - 1)
            common++
        }
    }
    return { added: midB.length - common, removed: midA.length - common }
}

/** One unified-diff hunk around the changed region (common head and tail trimmed), with 3 lines of context. */
export function makeHunk(before: string | null, after: string | null): string {
    const a = before === null || before === '' ? [] : before.replace(/\n$/, '').split('\n')
    const b = after === null || after === '' ? [] : after.replace(/\n$/, '').split('\n')
    let head = 0
    while (head < a.length && head < b.length && a[head] === b[head]) head++
    let tail = 0
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
    const aEnd = a.length - tail
    const bEnd = b.length - tail
    if (aEnd === head && bEnd === head) return ''
    const start = Math.max(0, head - CONTEXT)
    const after3 = Math.min(tail, CONTEXT)
    const lenA = aEnd + after3 - start
    const lenB = bEnd + after3 - start
    const lines = [
        `@@ -${lenA ? start + 1 : start},${lenA} +${lenB ? start + 1 : start},${lenB} @@`,
        ...a.slice(start, head).map(l => ' ' + l),
        ...a.slice(head, aEnd).map(l => '-' + l),
        ...b.slice(head, bEnd).map(l => '+' + l),
        ...a.slice(aEnd, aEnd + after3).map(l => ' ' + l),
    ]
    return lines.join('\n')
}

/** The first changed line of the new text, from a hunk's `+c,d` (1 when there is none). */
export function firstLine(hunk: string): number {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk)
    const ctx = hunk.split('\n').slice(1).findIndex(l => l.startsWith('+') || l.startsWith('-'))
    return m ? Math.max(1, Number(m[1]) + Math.max(0, ctx)) : 1
}

/**
 * Every fenced block of an answer (``` or ~~~, any language), in order, with its full text.
 * `lang` is the info string's first word ('' when absent); `label` is what follows `copy` in a ```copy block,
 * else the language. Fences follow CommonMark: up to 3 spaces of indent (stripped from the text too), the
 * closing fence the same character and at least as long; a block left open runs to the end of the answer.
 */
export function extractCopies(answer: string): { label: string; lang: string; text: string }[] {
    const out: { label: string; lang: string; text: string }[] = []
    const lines = answer.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '')
        if (!open) continue
        const indent = open[1]?.length ?? 0
        const fence = open[2] ?? '```'
        const info = (open[3] ?? '').trim()
        if (fence[0] === '`' && info.includes('`')) continue // an inline code span, not a fence
        const body: string[] = []
        let j = i + 1
        for (; j < lines.length; j++) {
            const l = lines[j] ?? ''
            const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l)
            if (close && close[1]?.[0] === fence[0] && (close[1]?.length ?? 0) >= fence.length) break
            body.push(l.replace(new RegExp(`^ {0,${indent}}`), ''))
        }
        i = j
        const text = body.join('\n')
        if (text.trim() === '') continue
        const [word = '', ...rest] = info.split(/\s+/)
        const isCopy = word.toLowerCase() === 'copy'
        const lang = isCopy ? '' : word
        out.push({ label: isCopy ? rest.join(' ') : lang, lang, text })
    }
    return out
}

/** The fenced blocks of every assistant message, numbered in chat order, newest first, at most `max`. */
export function copiesFrom(messages: readonly { role: string; text: string }[], max = KEEP_COPIES): Snippet[] {
    const all: Snippet[] = []
    for (const m of messages) {
        if (m.role !== 'assistant' || !m.text) continue
        for (const b of extractCopies(m.text)) all.push({ id: all.length + 1, ...b })
    }
    return all.reverse().slice(0, max)
}

// The chat's blocks, read again from the transcript; null when the engine does not give it.
async function readCopies($: EngineInterface): Promise<Snippet[] | null> {
    const msgs = await $.session.messages().catch(() => null)
    return Array.isArray(msgs) ? copiesFrom(msgs) : null
}

/** A folder's entries as an explorer lists them: folders first, then files, by name (numbers in order, case aside). */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
    return entries
        .filter(x => !HIDDEN.has(x.name))
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })))
}

/**
 * `git status --porcelain=v1 -z` read into absolute path → letter: U untracked, A added, D deleted, R renamed,
 * M anything else changed. `top` is the repository's top folder, which the paths are relative to.
 */
export function parseGitStatus(top: string, out: string): Record<string, string> {
    const res: Record<string, string> = {}
    const parts = out.split('\0')
    for (let i = 0; i < parts.length; i++) {
        const rec = parts[i] ?? ''
        if (rec.length < 4) continue
        const xy = rec.slice(0, 2)
        const path = `${top}/${rec.slice(3)}`.replace(/\/+$/, '')
        const letter = xy === '??' ? 'U' : xy.includes('A') ? 'A' : xy.includes('D') ? 'D' : xy.includes('R') ? 'R' : 'M'
        res[path] = letter
        if (xy.includes('R') || xy.includes('C')) i++ // the original path follows
    }
    return res
}

/** The letter a path's name is coloured by: git's, else this chat's edit (A new, M changed). */
export function statusOf(path: string, git: Record<string, string>, chat: Record<string, string>): string {
    return git[path] ?? chat[path] ?? ''
}

/** Whether a folder holds a changed path. */
export function holdsChange(dir: string, marks: Record<string, string>): boolean {
    const pre = dir.endsWith('/') ? dir : dir + '/'
    return Object.keys(marks).some(p => p.startsWith(pre))
}

export type TreeRow = { path: string; name: string; depth: number; isDir: boolean; isOpen: boolean; more: number; isEmpty: boolean }

/** The tree's visible rows: each open folder's entries under it, as far as it was listed; at most `max` rows. */
export function treeRows(root: string, tree: Record<string, DirList>, openDirs: readonly string[], max = MAX_ROWS): TreeRow[] {
    const open = new Set(openDirs)
    const rows: TreeRow[] = []
    const walk = (dir: string, depth: number) => {
        const list = tree[dir]
        if (!list) return
        for (const e of list.entries) {
            if (rows.length >= max) return
            const path = `${dir}/${e.name}`
            const isOpen = e.isDir && open.has(path)
            const sub = tree[path]
            rows.push({ path, name: e.name, depth, isDir: e.isDir, isOpen, more: 0, isEmpty: isOpen && !!sub && sub.entries.length === 0 })
            if (isOpen) walk(path, depth + 1)
        }
        if (list.more > 0 && rows.length < max) rows.push({ path: `${dir}/…`, name: '', depth, isDir: false, isOpen: false, more: list.more, isEmpty: false })
    }
    walk(root, 0)
    return rows
}

/** A path as the pane shows it: relative to the session folder, else with ~ for the home folder. */
export function shortPath(path: string, cwd: string): string {
    if (cwd && path.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) return path.slice(cwd.replace(/\/$/, '').length + 1)
    return path.replace(/^\/Users\/[^/]+(?=\/)/, '~').replace(/^\/home\/[^/]+(?=\/)/, '~')
}

/** Files grouped by folder, folders and files in name order. */
export function groupByFolder(files: FileChange[], cwd: string): { folder: string; files: (FileChange & { name: string })[] }[] {
    const groups = new Map<string, (FileChange & { name: string })[]>()
    for (const f of files) {
        const p = shortPath(f.path, cwd)
        const cut = p.lastIndexOf('/')
        const folder = cut < 0 ? '' : p.slice(0, cut + 1)
        const name = cut < 0 ? p : p.slice(cut + 1)
        groups.set(folder, [...(groups.get(folder) ?? []), { ...f, name }])
    }
    return [...groups.entries()]
        .sort(([x], [y]) => (x === '' ? -1 : y === '' ? 1 : x.localeCompare(y)))
        .map(([folder, list]) => ({ folder, files: list.sort((x, y) => x.name.localeCompare(y.name)) }))
}

export function addChange(list: Turn[], path: string, d: { added: number; removed: number }, isNew: boolean, hunk = '', snap = { before: '', after: '' }): Turn[] {
    const fresh: Turn = { id: 1, prompt: '', files: [], isDone: false }
    const turnsNow = list.length === 0 ? [fresh] : list
    const last = turnsNow[turnsNow.length - 1] ?? fresh
    const prev = last.files.find(f => f.path === path)
    const addHunk = (diff: string, isTooBig: boolean) => {
        if (isTooBig || !hunk) return { diff, isTooBig }
        const next = diff ? diff + '\n' + hunk : hunk
        return next.length > MAX_DIFF_CHARS ? { diff, isTooBig: true } : { diff: next, isTooBig: false }
    }
    const files = prev
        ? last.files.map(f =>
            f.path === path
                ? { ...f, added: f.added + d.added, removed: f.removed + d.removed, edits: f.edits + 1, ...addHunk(f.diff, f.isTooBig) }
                : f,
        )
        : [...last.files, { path, added: d.added, removed: d.removed, isNew, edits: 1, line: hunk ? firstLine(hunk) : 1, ...snap, ...addHunk('', false) }]
    return [...turnsNow.slice(0, -1), { ...last, files }]
}

export function summary(list: Turn[], snippets: Snippet[], lang: Lang = 'it'): string {
    const L = LABELS[lang]
    const last = list[list.length - 1]
    const parts: string[] = []
    if (last && last.files.length) parts.push(`${last.files.length} file ${totals(last.files)}`)
    else parts.push(L.untouched)
    if (snippets.length) parts.push(`${snippets.length} ${L.toCopyCount}`)
    return parts.join(' · ')
}

function markDone(t: Turn | undefined): Turn {
    return { ...(t ?? { id: 1, prompt: '', files: [] }), isDone: true }
}

function oneLine(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim()
    return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function totals(files: FileChange[]): string {
    const a = files.reduce((s, f) => s + f.added, 0)
    const r = files.reduce((s, f) => s + f.removed, 0)
    return `+${a} −${r}`
}

function isMode(v: unknown): v is Mode {
    return v === 'open' || v === 'mini' || v === 'closed'
}

function isView(v: unknown): v is View {
    return v === 'changes' || v === 'copy' || v === 'files'
}

// ---------- engine calls ----------

// Sets the mode, remembers it, and opens or closes the pane to match.
async function setMode($: EngineInterface, mode: Mode, focus = false): Promise<void> {
    await update($, modeAtom, () => mode).catch(() => { })
    await $.store.set(MODE_KEY, mode).catch(() => { })
    if (mode === 'open') await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS, ...(focus ? { focus: true as const } : {}) }).catch(() => { })
    else await $.ui.close({ id: PANE }).catch(() => { })
}

async function setView($: EngineInterface, view: View): Promise<void> {
    await update($, viewAtom, () => view).catch(() => { })
    await $.store.set(VIEW_KEY, view).catch(() => { })
}

// Opens what a message did to a file. A VS Code-family editor shows its diff view: the copy before the message on
// the left, on the right the file itself when nothing changed it since (so it stays editable), else the copy after.
// Other editors, or a file without copies, open the file at its first change.
async function openInEditor($: EngineInterface, f: FileChange, lang: Lang): Promise<void> {
    const ed = await read($, editorAtom)
    let argv: string[] = []
    let isDiff = false
    if (ed.diff && f.before && f.after && (await $.fs.exists(f.before).catch(() => false))) {
        const [now, after] = await Promise.all([$.fs.read(f.path).catch(() => null), $.fs.read(f.after).catch(() => null)])
        const right = typeof now === 'string' && now === after ? f.path : f.after
        argv = editorArgv(ed.diff, f.path, f.line, f.before, right)
        isDiff = true
    } else argv = editorArgv(ed.template, f.path, f.line)
    const res = argv.length ? await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => null) : null
    const L = LABELS[lang]
    $.ui.toast(res && res.exitCode === 0 ? `${isDiff ? L.diffIn : L.openedIn} ${ed.name}` : `${L.notOpened} ${f.path.split('/').pop()}`)
}

// One folder's listing; a symbolic link counts as a folder when it leads to one. null when it cannot be read.
async function readDir($: EngineInterface, dir: string): Promise<DirList | null> {
    const raw = await $.fs.list(dir).catch(() => null)
    if (!raw) return null
    const entries: TreeEntry[] = []
    for (const e of raw) {
        const isDir = e.kind === 'dir' || (e.isLink && (await $.fs.stat(`${dir}/${e.name}`).catch(() => null))?.kind === 'dir')
        entries.push({ name: e.name, isDir: !!isDir, isLink: e.isLink })
    }
    const sorted = sortEntries(entries)
    return { entries: sorted.slice(0, MAX_ENTRIES), more: Math.max(0, sorted.length - MAX_ENTRIES) }
}

async function listDir($: EngineInterface, dir: string): Promise<void> {
    const list = await readDir($, dir)
    if (list) await update($, treeAtom, t => ({ ...t, [dir]: list })).catch(() => { })
}

async function readGit($: EngineInterface, root: string): Promise<void> {
    const cmd = 'cd "$1" && git rev-parse --show-toplevel && git status --porcelain=v1 -z --untracked-files=all'
    const out = await $.process.run(['/bin/sh', '-c', cmd, 'sh', root], { timeoutMs: 5_000 }).catch(() => null)
    const text = out && out.exitCode === 0 ? out.stdout : ''
    const cut = text.indexOf('\n')
    const git = cut > 0 ? parseGitStatus(text.slice(0, cut), text.slice(cut + 1)) : {}
    await update($, gitAtom, () => git).catch(() => { })
}

// Lists the root and every open folder again (closing those that are gone), and reads git again.
async function refreshTree($: EngineInterface): Promise<void> {
    const root = await read($, rootAtom)
    if (!root) return
    const open = await read($, openDirsAtom)
    const alive: string[] = []
    for (const d of open) if (await $.fs.exists(d).catch(() => false)) alive.push(d)
    const lists = await Promise.all([root, ...alive].map(async d => [d, await readDir($, d)] as const))
    const tree: Record<string, DirList> = {}
    for (const [d, l] of lists) if (l) tree[d] = l
    await update($, treeAtom, () => tree).catch(() => { }) // swapped whole: no flash of an empty tree
    await update($, openDirsAtom, () => alive).catch(() => { })
    await readGit($, root)
}

async function toggleDir($: EngineInterface, dir: string): Promise<void> {
    const open = await read($, openDirsAtom)
    if (open.includes(dir)) {
        await update($, openDirsAtom, l => l.filter(d => d !== dir && !d.startsWith(dir + '/'))).catch(() => { })
        return
    }
    if (!(await read($, treeAtom))[dir]) await listDir($, dir)
    await update($, openDirsAtom, l => [...l, dir]).catch(() => { })
}

async function openFile($: EngineInterface, path: string, lang: Lang): Promise<void> {
    await update($, treeSelAtom, () => path).catch(() => { })
    const ed = await read($, editorAtom)
    const argv = editorArgv(ed.template, path, 1)
    const res = argv.length ? await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => null) : null
    const L = LABELS[lang]
    $.ui.toast(res && res.exitCode === 0 ? `${L.openedIn} ${ed.name}` : `${L.notOpened} ${path.split('/').pop()}`)
}

async function setTab($: EngineInterface, view: View): Promise<void> {
    await setView($, view)
    if (view === 'files') await refreshTree($)
}

async function toggleHunks($: EngineInterface, key: string): Promise<void> {
    await update($, expandedAtom, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key])).catch(() => { })
}

async function copySnippet($: EngineInterface, s: Snippet, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface'], lang: Lang): Promise<void> {
    const res = await $.ui.copy({ text: s.text, surface }).catch(() => ({ isCopied: false as const }))
    $.ui.toast(res.isCopied ? `${LABELS[lang].copied}: ${oneLine(s.label || s.text, 40)}` : LABELS[lang].notCopied)
}

// ---------- hooks ----------

export const register: Register = (on, options: PluginOptions) => {
    on('session.start', async ($, e, next) => {
        const r = await next(e)
        await update($, cwdAtom, () => e.cwd).catch(() => { })
        const root = await $.session.root().catch(() => e.cwd)
        await update($, rootAtom, () => (root || e.cwd).replace(/\/+$/, '')).catch(() => { })
        void refreshTree($)
        const fromChat = await readCopies($) // a resumed chat brings its blocks back
        if (fromChat) await update($, copies, () => fromChat).catch(() => { })
        const out = await $.process.run(['/bin/sh', '-c', PROBE], { timeoutMs: 5_000 }).catch(() => null)
        const probe = parseProbe(out?.stdout ?? '')
        const sid = await $.session.id().catch(() => 'session')
        await update($, snapAtom, () => `${probe.tmp}/claude-dashboard/${sid}`).catch(() => { })
        const setting = await $.settings.read({ key: 'language' }).catch(() => undefined)
        const lang = langOf(options.language, setting, probe)
        await update($, langAtom, () => lang).catch(() => { })
        const known = new Set<string>()
        if (probe.os === 'Darwin') {
            for (const x of EDITORS) if (await $.fs.exists(x.mac).catch(() => false)) known.add(x.mac)
        }
        await update($, editorAtom, () => pickEditor(options.editor, probe, p => known.has(p))).catch(() => { })
        await $.command.register({ name: 'dashboard', description: lang === 'en' ? 'Opens the dashboard: changes and texts to copy' : 'Apre la dashboard: modifiche e testi da copiare' }).catch(() => { })
        const storedView = await $.store.get(VIEW_KEY).catch(() => undefined)
        if (isView(storedView)) await update($, viewAtom, () => storedView).catch(() => { })
        const stored = await $.store.get(MODE_KEY).catch(() => undefined)
        const mode: Mode = isMode(stored) ? stored : 'open'
        await update($, modeAtom, () => mode).catch(() => { })
        if (mode === 'open') void $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS }).catch(() => { })
        return r
    })

    on('command.run', { command: 'dashboard' }, async $ => {
        await setMode($, 'open', true)
        return { text: LABELS[await read($, langAtom)].opened }
    }).catch(($, e, next) => next(e))

    // The ✕ on the pane's frame is the close: remembered, so the next session starts closed too.
    on('ui.close', async ($, e, next) => {
        if (e.id === PANE && e.origin.kind === 'person') {
            await update($, modeAtom, () => 'closed' as Mode).catch(() => { })
            await $.store.set(MODE_KEY, 'closed').catch(() => { })
        }
        return next(e)
    }).catch(($, e, next) => next(e))

    on('prompt.submit', async ($, e, next) => {
        if (!e.isMeta && !e.command) {
            await update($, turns, list => {
                const id = (list[list.length - 1]?.id ?? 0) + 1
                return [...list, { id, prompt: oneLine(e.text, 80), files: [], isDone: false }].slice(-KEEP_TURNS)
            }).catch(() => { })
        }
        return next(e)
    }).catch(($, e, next) => next(e))

    on('prompt.compose', async ($, e, next) => {
        const r = await next(e)
        return { sections: [...r.sections, { id: 'dashboard:copy', text: CONVENTION, scope: 'session' as const }] }
    })

    on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
        const path: string | undefined =
            'file_path' in e && typeof e.file_path === 'string' ? e.file_path
                : 'notebook_path' in e && typeof e.notebook_path === 'string' ? e.notebook_path
                    : undefined
        if (!path) return next(e)
        const read0 = await $.fs.read(path).catch(() => null)
        const ran = await next(e)
        if (ran.deny !== undefined || ran.isError) return ran
        const read1 = await $.fs.read(path).catch(() => null)
        const before = typeof read0 === 'string' ? read0 : null
        const after = typeof read1 === 'string' ? read1 : null
        const d = lineDiff(before, after)
        const hunk = makeHunk(before, after)
        // Copies for the editor's diff view: the file before its first edit in this message, and after the latest.
        const list0 = await read($, turns).catch(() => [] as Turn[])
        const last = list0[list0.length - 1]
        const base = await read($, snapAtom).catch(() => '')
        const snap = base ? snapPaths(base, last?.id ?? 1, path) : { before: '', after: '' }
        if (snap.before) {
            if (!last?.files.some(f => f.path === path)) await $.fs.write(snap.before, before ?? '').catch(() => { })
            await $.fs.write(snap.after, after ?? '').catch(() => { })
        }
        await update($, turns, list => addChange(list, path, d, read0 === null, hunk, snap)).catch(() => { })
        return ran
    }).catch(($, e, next) => next(e)) // the pane only watches: a failure here never blocks an edit

    on('turn.complete', async ($, e, next) => {
        const r = await next(e)
        if (e.agentId !== undefined) return r
        void refreshTree($) // files Claude created or removed show up
        await update($, turns, list => (list.length ? [...list.slice(0, -1), markDone(list[list.length - 1])] : list)).catch(() => { })
        const fromChat = await readCopies($)
        if (fromChat) await update($, copies, () => fromChat).catch(() => { })
        const found = fromChat ? [] : extractCopies(e.answer ?? '')
        if (found.length) {
            await update($, copies, list => {
                let id = list.reduce((m, s) => Math.max(m, s.id), 0)
                const added = found.map(f => ({ id: ++id, label: f.label, lang: f.lang, text: f.text }))
                return [...added.reverse(), ...list].slice(0, KEEP_COPIES)
            }).catch(() => { })
        }
        return r
    })

    // Minimised: one line above the prompt, under any other band.
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const rest = await next(e)
        if ((await read($, modeAtom)) !== 'mini' || e.props.hasSurvey) return rest
        const { Box, Text, Button } = $.ui.resolve(e)
        const lang = await read($, langAtom)
        const line = summary(await read($, turns), await read($, copies), lang)
        return (
            <Box flexDirection="column">
                {rest}
                <Box paddingX={1} flexDirection="row">
                    <Text dimColor wrap="truncate-end">◧ {TITLE} · {line} </Text>
                    <Button key="dashboard:open" hotkey="d" plain dimColor onPress={() => void setMode($, 'open', true)}>{LABELS[lang].open}</Button>
                    <Text> </Text>
                    <Button key="dashboard:close" plain dimColor onPress={() => void setMode($, 'closed')}>✕</Button>
                </Box>
            </Box>
        )
    })

    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
        const { Box, Text, Button, Code } = $.ui.resolve(e)
        const lang = await read($, langAtom)
        const L = LABELS[lang]
        const view = await read($, viewAtom)
        const list = await read($, turns)
        const snippets = await read($, copies)
        const cwd = await read($, cwdAtom)
        const expanded = await read($, expandedAtom)

        const tabs = (
            <Box flexDirection="row">
                <Button key="dashboard:tab-files" hotkey="f" plain dimColor={view !== 'files'} onPress={() => void setTab($, 'files')}>
                    {view === 'files' ? '▸ ' : '  '}{L.files}
                </Button>
                <Text>  </Text>
                <Button key="dashboard:tab-changes" hotkey="m" plain dimColor={view !== 'changes'} onPress={() => void setTab($, 'changes')}>
                    {view === 'changes' ? '▸ ' : '  '}{L.changes}
                </Button>
                <Text>  </Text>
                <Button key="dashboard:tab-copy" hotkey="c" plain dimColor={view !== 'copy'} onPress={() => void setTab($, 'copy')}>
                    {view === 'copy' ? '▸ ' : '  '}{L.toCopy}{snippets.length ? ` (${snippets.length})` : ''}
                </Button>
                <Text>  </Text>
                <Button key="dashboard:mini" hotkey="r" plain dimColor onPress={() => void setMode($, 'mini')}>{L.minimise}</Button>
            </Box>
        )

        if (view === 'files') {
            const root = await read($, rootAtom)
            const tree = await read($, treeAtom)
            const git = await read($, gitAtom)
            const sel = await read($, treeSelAtom)
            const chat: Record<string, string> = {}
            for (const t of list) for (const f of t.files) if (!chat[f.path] || f.isNew) chat[f.path] = f.isNew ? 'A' : 'M'
            const marks = { ...chat, ...git }
            const rows = treeRows(root, tree, await read($, openDirsAtom))
            const colorOf = (letter: string) =>
                letter === 'M' ? 'warning' : letter === 'U' || letter === 'A' ? 'success' : letter === 'D' ? 'error' : letter === 'R' ? 'suggestion' : undefined
            return (
                <Box flexDirection="column">
                    {tabs}
                    <Text> </Text>
                    <Box flexDirection="row">
                        <Text bold wrap="truncate-start">▾ {root.split('/').pop() || root} </Text>
                        <Button key="dashboard:tree-refresh" hotkey="a" plain dimColor onPress={() => void refreshTree($)}>{L.refresh}</Button>
                        <Text> </Text>
                        <Button key="dashboard:tree-collapse" plain dimColor onPress={() => void update($, openDirsAtom, () => [])}>{L.collapse}</Button>
                    </Box>
                    {!tree[root] && <Text dimColor>{L.noRoot}</Text>}
                    {rows.map(r => {
                        const pad = '  '.repeat(r.depth + 1)
                        if (r.more > 0) return <Text dimColor>{pad}… {L.more} {r.more}</Text>
                        const letter = r.isDir ? '' : statusOf(r.path, git, chat)
                        const dot = r.isDir && holdsChange(r.path, marks)
                        const color = r.isDir ? (dot ? 'warning' : undefined) : colorOf(letter)
                        return (
                            <Box flexDirection="column">
                                <Button key={`tree:${r.path}`} plain onPress={() => void (r.isDir ? toggleDir($, r.path) : openFile($, r.path, lang))}>
                                    <Text dimColor>{pad}{r.isDir ? (r.isOpen ? '▾ ' : '▸ ') : '  '}</Text>
                                    <Text {...(color ? { color } : {})} bold={r.path === sel}>{r.name}{r.isDir ? '/' : ''}</Text>
                                    {letter !== '' && <Text {...(colorOf(letter) ? { color: colorOf(letter) } : {})}> {letter}</Text>}
                                    {dot && <Text color="warning"> •</Text>}
                                </Button>
                                {r.isEmpty && <Text dimColor>{pad}    {L.emptyDir}</Text>}
                            </Box>
                        )
                    })}
                </Box>
            )
        }

        if (view === 'copy') {
            return (
                <Box flexDirection="column">
                    {tabs}
                    <Text> </Text>
                    {snippets.length === 0 && <Text dimColor>{L.noCopies}</Text>}
                    {snippets.map((s, i) => (
                        <Box flexDirection="column">
                            {i > 0 && <Text dimColor>{'─'.repeat(COLUMNS - 4)}</Text>}
                            <Button key={`copy:${s.id}`} {...(i < HOTKEYS ? { hotkey: String(i + 1) } : {})} plain onPress={press => void copySnippet($, s, press.surface, lang)}>
                                {i < HOTKEYS ? `[${i + 1}] ` : '[·] '}{L.copy}{s.label ? ` · ${oneLine(s.label, 40)}` : ''}
                            </Button>
                            <Code source={s.text} {...(s.lang ? { language: s.lang } : {})} wrap="wrap" />
                        </Box>
                    ))}
                </Box>
            )
        }

        // Every message that changed a file, newest first; the current one always, so its progress shows.
        const last = list[list.length - 1]
        const shown = list.filter(t => t === last || t.files.length > 0).reverse()

        return (
            <Box flexDirection="column">
                {tabs}
                <Text> </Text>
                {!last && <Text dimColor>{L.noMessage}</Text>}
                {shown.some(t => t.files.length > 0) && <Text dimColor>{L.pressFile}</Text>}
                {shown.map((t, i) => (
                    <Box flexDirection="column">
                        {i > 0 && <Text dimColor>{'─'.repeat(COLUMNS - 4)}</Text>}
                        <Text bold={t === last} dimColor={t !== last} wrap="truncate-end">
                            {t.isDone ? '✓' : '…'} ‹{t.id}› {t.prompt || L.message}
                        </Text>
                        {t.files.length === 0 && <Text dimColor>  {L.noFiles}</Text>}
                        {groupByFolder(t.files, cwd).map(g => (
                            <Box flexDirection="column">
                                {g.folder !== '' && <Text color="cyan" wrap="truncate-start">  {g.folder}</Text>}
                                {g.files.map(f => {
                                    const key = `${t.id}|${f.path}`
                                    const isOpen = expanded.includes(key)
                                    return (
                                        <Box flexDirection="column">
                                            <Box flexDirection="row">
                                                <Text>{g.folder !== '' ? '    ' : '  '}</Text>
                                                <Button key={`file:${key}`} plain onPress={() => void openInEditor($, f, lang)}>
                                                    <Text color="suggestion" underline>{f.name}</Text>
                                                </Button>
                                                <Text dimColor>{f.isNew ? ` (${L.isNew})` : ''}{f.edits > 1 ? ` ×${f.edits}` : ''} </Text>
                                                <Button key={`diff:${key}`} plain onPress={() => void toggleHunks($, key)}>
                                                    <Text color="success">+{f.added}</Text>
                                                    <Text> </Text>
                                                    <Text color="error">−{f.removed}</Text>
                                                    <Text dimColor> {isOpen ? '▾' : '▸'}</Text>
                                                </Button>
                                            </Box>
                                            {isOpen && f.isTooBig && <Text dimColor>      {L.diffTooBig}</Text>}
                                            {isOpen && !f.isTooBig && !f.diff && <Text dimColor>      {L.noDiff}</Text>}
                                            {isOpen && !f.isTooBig && f.diff && <Code source={f.diff} format="diff" path={f.path} wrap="truncate-end" />}
                                        </Box>
                                    )
                                })}
                            </Box>
                        ))}
                        {t.files.length > 1 && (
                            <Text dimColor>
                                {'  '}{L.total} {t.files.length} file{' '}
                                <Text color="success">+{t.files.reduce((n, f) => n + f.added, 0)}</Text>{' '}
                                <Text color="error">−{t.files.reduce((n, f) => n + f.removed, 0)}</Text>
                            </Text>
                        )}
                    </Box>
                ))}
            </Box>
        )
    })
}
