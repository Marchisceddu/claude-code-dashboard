import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { addChange, copiesFrom, editorArgv, holdsChange, parseGitStatus, snapPaths, sortEntries, statusOf, treeRows, extractCopies, firstLine, groupByFolder, langOf, lineDiff, makeHunk, parseProbe, pickEditor, shortPath, summary } from '../hooks/register'

test('a new file counts every line as added', () => {
  expect(lineDiff(null, 'a\nb\nc')).toEqual({ added: 3, removed: 0 })
})

test('an edit in the middle counts only the changed lines', () => {
  expect(lineDiff('a\nb\nc\nd', 'a\nB\nc\nd')).toEqual({ added: 1, removed: 1 })
  expect(lineDiff('a\nb\nc', 'a\nb\nx\ny\nc')).toEqual({ added: 2, removed: 0 })
})

test('the hunk shows the change with three lines of context', () => {
  const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n'
  const after = '1\n2\n3\n4\nCINQUE\n6\n7\n8\n9\n'
  expect(makeHunk(before, after)).toBe('@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+CINQUE\n 6\n 7\n 8')
  expect(makeHunk('a\n', 'a\n')).toBe('')
  expect(makeHunk(null, 'x\ny\n')).toBe('@@ -0,0 +1,2 @@\n+x\n+y')
})

test('the editor opens at the first changed line', () => {
  expect(firstLine('@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+CINQUE')).toBe(5)
  expect(firstLine('@@ -0,0 +1,2 @@\n+x')).toBe(1)
  expect(firstLine('')).toBe(1)
})

test('every fenced block is extracted in full, in order, each on its own', () => {
  const answer = [
    'Ecco:', '```copy Email al cliente', 'Ciao Luca,', '', 'grazie.', '```', 'e poi',
    '```bash', 'cd ~/x', 'ls -la', '```',
    '```', 'senza lingua', '```',
    '1. passo', '   ```sh', '   echo rientrato', '     due spazi in più', '   ```',
    '````md', '```js', 'annidato', '```', '````',
    '```copy', '   ', '```',
    'testo con `codice` inline e ``` in mezzo',
    '~~~python', 'print(1)',
  ].join('\n')
  expect(extractCopies(answer)).toEqual([
    { label: 'Email al cliente', lang: '', text: 'Ciao Luca,\n\ngrazie.' },
    { label: 'bash', lang: 'bash', text: 'cd ~/x\nls -la' },
    { label: '', lang: '', text: 'senza lingua' },
    { label: 'sh', lang: 'sh', text: 'echo rientrato\n  due spazi in più' },
    { label: 'md', lang: 'md', text: '```js\nannidato\n```' },
    { label: 'python', lang: 'python', text: 'print(1)' },
  ])
})

test('the blocks of the whole chat, newest first, user messages left out', () => {
  const chat = [
    { role: 'user', text: '```\nmio\n```' },
    { role: 'assistant', text: '```bash\nprimo\n```\n```\nsecondo\n```' },
    { role: 'assistant', text: 'nessun blocco' },
    { role: 'assistant', text: '```copy Mail\nterzo\n```' },
  ]
  expect(copiesFrom(chat).map(s => [s.id, s.text, s.label])).toEqual([[3, 'terzo', 'Mail'], [2, 'secondo', ''], [1, 'primo', 'bash']])
  expect(copiesFrom(chat, 2).map(s => s.text)).toEqual(['terzo', 'secondo'])
})

test('paths are shown relative to the session folder, else with ~', () => {
  expect(shortPath('/Users/m/p/src/a.ts', '/Users/m/p')).toBe('src/a.ts')
  expect(shortPath('/Users/m/other/b.md', '/Users/m/p')).toBe('~/other/b.md')
})

test('files are grouped by folder, root first', () => {
  const f = (path: string) => ({ path, added: 1, removed: 0, isNew: false, edits: 1, line: 1, diff: '', isTooBig: false, before: '', after: '' })
  const groups = groupByFolder([f('/p/src/b.ts'), f('/p/README.md'), f('/p/src/a.ts')], '/p')
  expect(groups.map(g => g.folder)).toEqual(['', 'src/'])
  expect(groups[1]?.files.map(x => x.name)).toEqual(['a.ts', 'b.ts'])
})

test('two edits of one file in a turn add up, hunks one after the other', () => {
  let t = addChange([{ id: 1, prompt: 'x', files: [], isDone: false }], '/p/a.ts', { added: 2, removed: 1 }, false, '@@ -1,1 +1,2 @@\n-a\n+b\n+c')
  t = addChange(t, '/p/a.ts', { added: 3, removed: 0 }, false, '@@ -5,0 +6,1 @@\n+d')
  expect(t[0]?.files[0]).toEqual({ path: '/p/a.ts', added: 5, removed: 1, isNew: false, edits: 2, line: 1, diff: '@@ -1,1 +1,2 @@\n-a\n+b\n+c\n@@ -5,0 +6,1 @@\n+d', isTooBig: false, before: '', after: '' })
})

test('labels: the option, else the language setting, else the system locale, else English', () => {
  const none = { locale: '', appleLocale: '' }
  expect(langOf('it', 'english', none)).toBe('it')
  expect(langOf('auto', 'English', { locale: 'it_IT.UTF-8', appleLocale: 'it_IT' })).toBe('en')
  expect(langOf('auto', 'italiano', none)).toBe('it')
  expect(langOf('auto', undefined, { locale: 'C.UTF-8', appleLocale: 'it_IT' })).toBe('it')
  expect(langOf('auto', undefined, { locale: 'it_IT.UTF-8', appleLocale: '' })).toBe('it')
  expect(langOf('auto', undefined, { locale: 'de_DE.UTF-8', appleLocale: '' })).toBe('en')
  expect(langOf(undefined, undefined, none)).toBe('en')
  expect(summary([], [], 'en')).toBe('no file changed')
})

test('the editor: the option first, then the app the session runs in, then the first found, then the system opener', () => {
  const mac = parseProbe('Darwin\ncom.microsoft.VSCode\n\nC.UTF-8\nit_IT\n')
  const all = () => true
  expect(pickEditor('subl {file}:{line}', mac, all)).toEqual({ name: 'subl', template: 'subl {file}:{line}', diff: '' })
  expect(pickEditor('"/opt/x/bin/code" -g {file}:{line}', mac, all).diff).toBe('"/opt/x/bin/code" --diff {before} {after}')
  expect(pickEditor('', mac, all).diff).toBe('"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --diff {before} {after}')
  expect(pickEditor('', mac, all).name).toBe('VS Code')
  expect(pickEditor('', parseProbe('Darwin\ncom.googlecode.iterm2\n'), all).name).toBe('Antigravity IDE')
  expect(pickEditor('', mac, () => false)).toEqual({ name: 'macOS', template: '/usr/bin/open {file}', diff: '' })
  const linux = parseProbe('Linux\n\nvscode\nit_IT.UTF-8\n\n/usr/bin/code\n')
  expect(pickEditor('', linux, () => false)).toEqual({ name: 'VS Code', template: '"/usr/bin/code" -g {file}:{line}', diff: '"/usr/bin/code" --diff {before} {after}' })
  expect(pickEditor('', parseProbe('Linux\n\n\n\n\n'), () => false).template).toBe('xdg-open {file}')
})

test('the probe reads the temporary folder apart from the editors on PATH', () => {
  const p = parseProbe('Darwin\n\n\nC\nit_IT\n/usr/local/bin/code\ntmp=/var/folders/x/T/\n')
  expect(p.onPath).toEqual(['/usr/local/bin/code'])
  expect(p.tmp).toBe('/var/folders/x/T')
  expect(parseProbe('').tmp).toBe('/tmp')
})

test('copies before and after: one folder per message and file, the name kept', () => {
  const a = snapPaths('/t/s', 3, '/p/src/a.ts')
  expect(a.before).toMatch(/^\/t\/s\/m3\/[0-9a-f]+\/before\/a\.ts$/)
  expect(a.after).toBe(a.before.replace('/before/', '/after/'))
  expect(snapPaths('/t/s', 3, '/p/lib/a.ts').before).not.toBe(a.before)
})

test('an editor template becomes the command to run', () => {
  expect(editorArgv('"/Applications/My Editor.app/bin/ed" -g {file}:{line}', '/p/a b.ts', 7)).toEqual(['/Applications/My Editor.app/bin/ed', '-g', '/p/a b.ts:7'])
  expect(editorArgv('code --diff {before} {after}', '/p/a.ts', 1, '/t/b/a.ts', '/p/a.ts')).toEqual(['code', '--diff', '/t/b/a.ts', '/p/a.ts'])
})

test('the minimised line sums up the last message', () => {
  const t = [{ id: 1, prompt: 'x', files: [{ path: '/p/a', added: 3, removed: 1, isNew: false, edits: 1, line: 1, diff: '', isTooBig: false, before: '', after: '' }], isDone: true }]
  expect(summary(t, [{ id: 1, label: 'l', lang: '', text: 't' }])).toBe('1 file +3 −1 · 1 da copiare')
  expect(summary([], [])).toBe('nessun file toccato')
})

const PANE = {
  plugin: 'dashboard',
  component: 'Pane',
  requestId: 'dashboard',
  props: { title: 'Dashboard', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function engine(on: Parameters<TestBody>[1], store: Map<string, unknown>, opened: string[], closed: string[], exists = (p: string) => p.includes('Antigravity IDE')) {
  on('command.register', () => ({ value: { command: 'dashboard' } }))
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', (_, e) => { closed.push(e.id); return { value: undefined } })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('settings.read', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('fs.exists', (_, e) => ({ value: exists(String(e.path)) }))
}

test('Modifiche lists the file with its diff, Da copiare the text, on every surface', async ($, on) => {
  let content = 'uno\ndue\n'
  const files = new Map<string, string>()
  engine(on, new Map(), [], [], p => files.has(p) || p.includes('Antigravity IDE'))
  on('fs.read', (_, e) => ({ value: files.get(String(e.path)) ?? content }))
  on('fs.write', (_, e) => { files.set(String(e.path), String(e.text)); return { value: undefined } })
  on('session.id', () => ({ value: 'S1' }) as never)
  on('tool.call', () => {
    content = 'uno\nDUE\ntre\n'
    return { result: {} }
  })
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: e.argv[0] === '/bin/sh' ? 'Darwin\ncom.google.antigravity-ide\n\nC.UTF-8\nit_IT\ntmp=/T/\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'sistema il file' } as Parameters<typeof $.prompt.submit>[0])
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/a.ts', old_string: 'due', new_string: 'DUE\ntre' })
  await $.turn.complete({ answer: 'Fatto.\n```copy Messaggio\nCiao a tutti\n```\nPoi:\n```bash\ngit add .\ngit commit -m "x"\n```', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'diff:1|/p/src/a.ts' }))?.text).toContain('+2')
    expect((await ui.find({ type: 'Button', key: 'file:1|/p/src/a.ts' }))?.text).toBe('a.ts')
    expect((await ui.find({ type: 'Text', text: /sistema il file/ }))?.text).toContain('✓')
    expect(await ui.find({ type: 'Code' })).toBeFalsy() // hunks hidden until +/− is pressed
    await ui.press({ key: 'diff:1|/p/src/a.ts' })
    expect(await ui.find({ type: 'Code', text: /\+DUE/ })).toBeTruthy()
    await ui.press({ key: 'diff:1|/p/src/a.ts' })
    expect(await ui.find({ type: 'Code' })).toBeFalsy()
    await ui.press({ key: 'file:1|/p/src/a.ts' })
    const { before, after } = snapPaths('/T/claude-dashboard/S1', 1, '/p/src/a.ts')
    expect(files.get(before)).toBe('uno\ndue\n')
    expect(files.get(after)).toBe('uno\nDUE\ntre\n')
    // unchanged since: the right side is the file itself, editable
    expect(ran[ran.length - 1]).toEqual(['/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide', '--diff', before, '/p/src/a.ts'])
    await ui.press({ key: 'dashboard:tab-copy' })
    expect(await ui.find({ type: 'Button', text: /Messaggio/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', text: /bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Code', text: /git add \.\ngit commit -m "x"/ })).toBeTruthy()
    expect(await ui.find({ type: 'Code', text: /Ciao a tutti/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /───/ })).toBeTruthy()
    expect((await ui.find({ type: 'Button', text: /bash/ }))?.text).toContain('[1]') // newest first
    await ui.press({ key: 'dashboard:tab-changes' })
    await ui.unmount()
  }
})

test('Modifiche shows every message that changed files, newest first; a file changed since opens its copy', async ($, on) => {
  const files = new Map<string, string>([['/p/a.ts', 'v0\n']])
  engine(on, new Map(), [], [], p => files.has(p) || p.includes('Antigravity IDE'))
  on('fs.read', (_, e) => ({ value: files.get(String(e.path)) ?? null }) as never)
  on('fs.write', (_, e) => { files.set(String(e.path), String(e.text)); return { value: undefined } })
  on('session.id', () => ({ value: 'S' }) as never)
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: e.argv[0] === '/bin/sh' ? 'Darwin\ncom.google.antigravity-ide\n\nC\nit_IT\ntmp=/T\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  let n = 0
  on('tool.call', () => { files.set('/p/a.ts', `v${++n}\n`); return { result: {} } })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  for (const text of ['primo', 'secondo', 'terzo senza file']) {
    await $.prompt.submit({ text } as Parameters<typeof $.prompt.submit>[0])
    if (text !== 'terzo senza file') await $.tool.call({ tool: 'Edit', file_path: '/p/a.ts', old_string: 'v', new_string: 'w' })
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: text, reason: 'answer' })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const headers = (await ui.findAll({ type: 'Text', text: /‹\d›/ })).map(x => x.text)
  expect(headers.map(h => h.replace(/^\S+ /, ''))).toEqual(['‹3› terzo senza file', '‹2› secondo', '‹1› primo'])
  expect(await ui.find({ type: 'Button', key: 'file:2|/p/a.ts' })).toBeTruthy()
  await ui.press({ key: 'file:1|/p/a.ts' })
  const one = snapPaths('/T/claude-dashboard/S', 1, '/p/a.ts')
  expect(ran[ran.length - 1]?.slice(1)).toEqual(['--diff', one.before, one.after]) // a.ts changed again in ‹2›
  expect(files.get(one.before)).toBe('v0\n')
  expect(files.get(one.after)).toBe('v1\n')
  await ui.unmount()
})

test('Da copiare shows every block of the chat, not only the last answer', async ($, on) => {
  engine(on, new Map(), [], [])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const chat = [
    { role: 'user', text: 'uno', toolUses: [] },
    { role: 'assistant', text: '```sh\nvecchio comando\n```', toolUses: [] },
    { role: 'user', text: 'due', toolUses: [] },
    { role: 'assistant', text: '```copy Ultimo\nnuovo testo\n```', toolUses: [] },
  ]
  on('session.messages', () => ({ value: chat }) as never)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '```copy Ultimo\nnuovo testo\n```', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'dashboard:tab-copy' })
  expect((await ui.find({ type: 'Button', text: /Ultimo/ }))?.text).toContain('[1]')
  expect((await ui.find({ type: 'Button', text: /sh/ }))?.text).toContain('[2]')
  expect(await ui.find({ type: 'Code', text: /vecchio comando/ })).toBeTruthy()
  await ui.unmount()
})

test('riduci closes the pane and shows the line above the prompt; apri brings it back', { options: { language: 'it' } }, async ($, on) => {
  const opened: string[] = []
  const closed: string[] = []
  const store = new Map<string, unknown>()
  engine(on, store, opened, closed)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['dashboard'])

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Button', text: /chiudi/ })).toBeFalsy()
  await pane.press({ key: 'dashboard:mini' })
  await pane.unmount()
  expect(closed).toEqual(['dashboard'])
  expect(store.get('mode')).toBe('mini')

  const band = await $.ui.mount({ plugin: 'dashboard', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false } } as never)
  expect((await band.find({ type: 'Text', text: /Dashboard/ }))?.text).toContain('nessun file toccato')
  await band.press({ key: 'dashboard:open' })
  await band.unmount()
  expect(opened).toEqual(['dashboard', 'dashboard'])
  expect(store.get('mode')).toBe('open')
})

test('Files: folders first, by name with numbers in order, .git and .DS_Store hidden', () => {
  const e = (name: string, isDir = false) => ({ name, isDir, isLink: false })
  expect(sortEntries([e('b.ts'), e('src', true), e('file10'), e('.git', true), e('A.md'), e('file2'), e('.DS_Store'), e('.claude', true)]).map(x => x.name))
    .toEqual(['.claude', 'src', 'A.md', 'b.ts', 'file2', 'file10'])
})

test('Files: git status letters by absolute path, renames and untracked included', () => {
  const out = ' M src/a.ts\0?? new.txt\0A  added.ts\0R  b2.ts\0b.ts\0 D gone.ts\0'
  expect(parseGitStatus('/r', out)).toEqual({ '/r/src/a.ts': 'M', '/r/new.txt': 'U', '/r/added.ts': 'A', '/r/b2.ts': 'R', '/r/gone.ts': 'D' })
  expect(statusOf('/r/x', {}, { '/r/x': 'A' })).toBe('A')
  expect(statusOf('/r/src/a.ts', { '/r/src/a.ts': 'M' }, { '/r/src/a.ts': 'A' })).toBe('M')
  expect(holdsChange('/r/src', { '/r/src/a.ts': 'M' })).toBe(true)
  expect(holdsChange('/r/sr', { '/r/src/a.ts': 'M' })).toBe(false)
})

test('Files: rows of the open folders only, nested under their folder, cut where the listing was', () => {
  const e = (name: string, isDir = false) => ({ name, isDir, isLink: false })
  const tree = {
    '/r': { entries: [e('src', true), e('docs', true), e('a.md')], more: 2 },
    '/r/src': { entries: [e('x.ts')], more: 0 },
    '/r/docs': { entries: [e('y.md')], more: 0 },
  }
  const rows = treeRows('/r', tree, ['/r/src'])
  expect(rows.map(r => [r.name, r.depth, r.isOpen])).toEqual([['src', 0, true], ['x.ts', 1, false], ['docs', 0, false], ['a.md', 0, false], ['', 0, false]])
  expect(rows[4]?.more).toBe(2)
  expect(treeRows('/r', tree, ['/r/src'], 2)).toHaveLength(2)
})

test('Files tab: opens folders with a click, a file in the editor, colours by git', async ($, on) => {
  engine(on, new Map(), [], [], p => p.includes('Antigravity IDE') || p.startsWith('/r'))
  const fsTree: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
    '/r': [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }, { name: '.git', kind: 'dir' }],
    '/r/src': [{ name: 'a.ts', kind: 'file' }],
  }
  on('fs.list', (_, e) => ({ value: (fsTree[String(e.path)] ?? []).map(x => ({ ...x, size: 0, mtimeMs: 0, isLink: false })) }))
  on('session.root', () => ({ value: '/r' }) as never)
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const isGit = e.argv.includes('/r') && String(e.argv[2] ?? '').includes('git')
    const stdout = isGit ? '/r\n M src/a.ts\0' : e.argv[0] === '/bin/sh' ? 'Darwin\ncom.google.antigravity-ide\n\nC\nit_IT\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'dashboard:tab-files' })
  expect(await ui.find({ type: 'Button', key: 'tree:/r/.git' })).toBeFalsy()
  expect((await ui.find({ type: 'Button', key: 'tree:/r/src' }))?.text).toContain('•')
  expect(await ui.find({ type: 'Button', key: 'tree:/r/src/a.ts' })).toBeFalsy()
  await ui.press({ key: 'tree:/r/src' })
  expect((await ui.find({ type: 'Button', key: 'tree:/r/src/a.ts' }))?.text).toContain('M')
  await ui.press({ key: 'tree:/r/src/a.ts' })
  expect(ran[ran.length - 1]).toEqual(['/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide', '-g', '/r/src/a.ts:1'])
  await ui.press({ key: 'tree:/r/src' })
  expect(await ui.find({ type: 'Button', key: 'tree:/r/src/a.ts' })).toBeFalsy()
  await ui.unmount()
})
