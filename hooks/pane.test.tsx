import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { addAgent, fileOf, fileTree, gitChanges, MAX_AGENTS, noteFile, parseGitStatus, shortCount, shortDuration, shortModel } from './agents'
import { staleLogs } from './logs'
import { summarize } from './report'
import type { AgentRow } from '../types'
import { CONFIG_JSON } from './fixture'

const PANE = {
  plugin: 'gearbox',
  component: 'Pane',
  requestId: 'gearbox-agents',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Nothing sits below the mod: these hooks play the engine. Ollama is missing here, so the
// rules alone decide: implement, routine → sonnet:high. Git answers `statuses` in turn.
function engine(on: On, statuses: string[] = []) {
  on('clock.now', () => ({ value: 0 }))
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: JSON.stringify(CONFIG_JSON) as never }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'git') {
      return { deny: 'ollama: command not found' }
    }
    const stdout = e.argv.includes('rev-parse') ? '/project\n' : (statuses.shift() ?? '')
    return { value: { exitCode: 0, stdout, stderr: '' } as never }
  })
  on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel, agentId: 'agent-1' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', () => ({ result: {} }))
}

async function spawnAndWork($: any) {
  await $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'Fix the parser in src/parse.rs',
    description: 'Fix the parser',
    subagentType: 'rust-engineer',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  const step = $.turn.step({ turnId: 't1', index: 0, messageCount: 1, model: 'claude-sonnet-5-5', effort: 'medium', agentId: 'agent-1' })
  for await (const _ of step) {
    // no chunks: the fake engine's answer is empty
  }
  await $.tool.call({ tool: 'Read', file_path: '/project/src/parse.rs', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Edit', file_path: '/project/src/parse.rs', old_string: 'a', new_string: 'b', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Read', file_path: '/project/Cargo.toml', agentId: 'agent-1' })
}

// The tree and the rows

test('files show as a tree, directories first, single-child directories folded', () => {
  let list = noteFile([], '/p/src/a/b/x.rs', 'read')
  list = noteFile(list, '/p/README.md', 'read')
  list = noteFile(list, '/p/src/a/b/x.rs', 'edit')
  list = noteFile(list, '/p/src/a/b/x.rs', 'read')
  list = noteFile(list, '/elsewhere/y.txt', 'write')
  const lines = fileTree(list, '/p').map(l => `${l.prefix}${l.name}${l.op ? ` ${l.op}` : ''}${(l.count ?? 0) > 1 ? ` x${l.count}` : ''}`)
  expect(lines).toEqual(['├─ elsewhere/', '│  └─ y.txt write', '├─ src/a/b/', '│  └─ x.rs edit x3', '└─ README.md read'])
})

test('only the tools that name one file count, and the pane keeps the running agents', () => {
  expect(fileOf('Read', { file_path: '/a' })).toEqual({ path: '/a', op: 'read' })
  expect(fileOf('NotebookEdit', { notebook_path: '/n.ipynb' })).toEqual({ path: '/n.ipynb', op: 'edit' })
  expect(fileOf('Bash', { command: 'cat /a' })).toBe(null)
  expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
  expect(shortModel('haiku')).toBe('haiku')

  const row = (id: string, status: AgentRow['status']): AgentRow => ({ id, description: id, type: 't', model: '', effort: '', status, startedAt: 0, tokens: 0 })
  let rows: AgentRow[] = [row('busy', 'running')]
  for (let i = 0; i < MAX_AGENTS + 5; i++) {
    rows = addAgent(rows, row(`a${i}`, 'done'))
  }
  expect(rows.length).toBe(MAX_AGENTS)
  expect(rows.some(r => r.id === 'busy')).toBe(true)
})

// The pane in a session

test('the pane shows the agent, its model, effort and pick, and its files once selected', async ($, on) => {
  engine(on)
  await spawnAndWork($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /1 running/ }))?.text).toBe('1 running · 0 finished')
    expect(await ui.find({ type: 'Text', text: /sonnet 5\.5 · medium/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gearbox → sonnet:high/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'select-agent-1' })
  await ui.unmount()

  const opened = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await opened.find({ type: 'Text', text: /src\// })).toBeDefined()
  expect(await opened.find({ type: 'Text', text: /M parse\.rs ×2/ })).toBeDefined()
  expect(await opened.find({ type: 'Text', text: /R Cargo\.toml/ })).toBeDefined()
  await opened.unmount()
})

test('a finished agent is marked done', async ($, on) => {
  engine(on)
  await spawnAndWork($)
  await $.turn.complete({ turnId: 't1', agentId: 'agent-1', reason: 'answer', answer: 'ok', durationMs: 10 } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /running/ }))?.text).toBe('0 running · 1 finished')
  await ui.unmount()
})

test('a Bash command is credited with the files whose git status it changed', async ($, on) => {
  // Before: one file already modified. After: it is still, and the command added another.
  engine(on, [' M src/old.rs\0', ' M src/old.rs\0?? target/new.txt\0'])
  await spawnAndWork($)
  await $.tool.call({ tool: 'Bash', command: 'cargo run > target/new.txt', agentId: 'agent-1' })
  await $.ui.mount({ ...PANE, surface: 'terminal' }).then(async ui => {
    await ui.press({ key: 'select-agent-1' })
    await ui.unmount()
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /B new\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /old\.rs/ })).toBeUndefined()
  await ui.unmount()
})

test('the pane shows tokens and time, and a button to open the agent', async ($, on) => {
  engine(on)
  await spawnAndWork($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /tokens · / })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'view-agent-1' })).toBeDefined()
  await ui.unmount()
})

test('git status, counts and durations are read and written as expected', () => {
  const before = parseGitStatus(' M a.rs\0R  new.rs\0old.rs\0')
  expect([...before.entries()]).toEqual([['a.rs', ' M'], ['new.rs', 'R ']])
  const after = parseGitStatus(' M a.rs\0R  new.rs\0old.rs\0?? b.rs\0MM c.rs\0')
  expect(gitChanges(before, after)).toEqual(['b.rs', 'c.rs'])
  expect(shortCount(950)).toBe('950')
  expect(shortCount(12_345)).toBe('12.3k')
  expect(shortDuration(83_000)).toBe('1m 23s')
  expect(shortDuration(4_000)).toBe('4s')
})

test('only other sessions\' logs older than the retention are stale', () => {
  const day = 24 * 60 * 60 * 1000
  const now = 100 * day
  const entries = [
    { name: 'old-session', mtimeMs: now - 40 * day, isLink: false },
    { name: 'old-file.jsonl', mtimeMs: now - 40 * day, isLink: false },
    { name: 'recent', mtimeMs: now - day, isLink: false },
    { name: 'current', mtimeMs: now - 40 * day, isLink: false },
    { name: 'a link', mtimeMs: now - 40 * day, isLink: true },
    { name: '../escape', mtimeMs: now - 40 * day, isLink: false },
  ]
  expect(staleLogs(entries, now, 30, 'current')).toEqual(['old-session', 'old-file.jsonl'])
  expect(staleLogs(entries, now, 0, 'current')).toEqual([])
})

test('the report compares picks with what ran and how it ended', () => {
  const spawn = (agentId: string, recommended: string, ranOn: string, work: string) => ({
    kind: 'spawn', agentId, recommended, ranOn, why: [`${work}, Routine`], laya: { work: {} },
  })
  const lines = [
    spawn('a', 'sonnet:high', 'claude-sonnet-5-5', 'implement'),
    { kind: 'step', agentId: 'a', effort: 'high' },
    { kind: 'end', agentId: 'a', reason: 'answer', tokens: 1000 },
    spawn('b', 'haiku:low', 'claude-opus-5-5', 'search'),
    { kind: 'step', agentId: 'b', effort: 'medium' },
    { kind: 'end', agentId: 'b', reason: 'answer', tokens: 5000 },
    spawn('c', 'opus:high', 'claude-sonnet-5-5', 'diagnose'),
    { kind: 'end', agentId: 'c', reason: 'error', tokens: 2000 },
    { kind: 'spawn', recommended: 'opus:high' },
  ]
  const text = summarize(lines, ['haiku', 'sonnet', 'opus'], 'all sessions')
  expect(text).toContain('3 assessed subagents, Laya answered for 100%')
  expect(text).toContain('Model: gearbox agrees on 33% of 3; it would go higher for 1, lower for 1.')
  expect(text).toContain('Effort: gearbox agrees on 50% of 2')
  expect(text).toContain('Room to save: 1 agents answered on a model above gearbox\'s pick, using 5.0k tokens.')
  expect(text).toContain('Too low?: 1 agents did not answer')
  expect(summarize([], ['opus'], 'this session')).toContain('no assessed subagents')
})
