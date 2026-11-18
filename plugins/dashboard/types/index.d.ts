export type FileChange = {
  path: string
  added: number
  removed: number
  isNew: boolean
  edits: number
  /** First changed line, where the editor opens the file. */
  line: number
  /** Unified-diff hunks of this file in this message, one per edit. */
  diff: string
  isTooBig: boolean
  /** Copies of the file before the message's first edit and after its latest, for the editor's diff view ('' if none). */
  before: string
  after: string
}
export type Turn = { id: number; prompt: string; files: FileChange[]; isDone: boolean }
/** A fenced block of an answer: `lang` its language ('' if none or `copy`), `label` the copy label or the language. */
export type Snippet = { id: number; label: string; lang: string; text: string }
export type Mode = 'open' | 'mini' | 'closed'
export type View = 'changes' | 'copy' | 'files'
/** One entry of a listed folder in the Files tab. */
export type TreeEntry = { name: string; isDir: boolean; isLink: boolean }
/** A listed folder: its entries (at most a few hundred) and how many more were left out. */
export type DirList = { entries: TreeEntry[]; more: number }
export type Lang = 'it' | 'en'
/** The command files open with: a template whose {file} and {line} are filled in. */
export type Editor = { name: string; template: string; /** with {before} and {after}; '' when the editor has no diff view */ diff: string }

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      turns: Shaped<Turn[]>
      copies: Shaped<Snippet[]>
      cwd: string
      mode: Mode
      view: View
      expanded: Shaped<string[]>
      snap: string
      root: string
      tree: Shaped<Record<string, DirList>>
      openDirs: Shaped<string[]>
      git: Shaped<Record<string, string>>
      treeSel: string
      lang: Lang
      editor: Shaped<Editor>
    }
  }
}
