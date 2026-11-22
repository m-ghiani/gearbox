import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { addAgent, expiredAgents, fileOf, fileTree, gitChanges, MAX_AGENTS, noteFile, parseGitStatus, shortCount, shortDollars, shortDuration, shortModel, statusText } from './agents'
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
// rules alone decide: implement, routine → sonnet:high. Git answers `statuses` in turn. A test
// that drives time itself takes `clock: false` and a mock.clock.
function engine(on: On, statuses: string[] = [], { clock = true } = {}) {
  const seen = { toasts: [] as string[], statuses: [] as (string | undefined)[] }
  if (clock) {
    on('clock.now', () => ({ value: 0 }))
  }
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: JSON.stringify(CONFIG_JSON) as never }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text === undefined ? undefined : String(e.text))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'git') {
      return { deny: 'ollama: command not found' }
    }
    const stdout = e.argv.includes('rev-parse') ? '/project\n' : (statuses.shift() ?? '')
    return { value: { exitCode: 0, stdout, stderr: '' } as never }
  })
  on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel, agentId: 'agent-1' }))
  on('turn.step', async function* (_, e) {
    const usage = { model: e.model, input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', () => ({ result: {} }))
  return seen
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
    expect((await ui.find({ type: 'Text', text: /RUNNING/ }))?.text).toBe(' RUNNING · 1')
    expect(await ui.find({ type: 'Text', text: /FINISHED/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /sonnet 5\.5 · medium/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⚙ gearbox → sonnet:high/ })).toBeDefined()
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

test('a finished agent moves under FINISHED and says how it ended', async ($, on) => {
  engine(on)
  await spawnAndWork($)
  await $.turn.complete({ turnId: 't1', agentId: 'agent-1', reason: 'answer', answer: 'ok', durationMs: 72_000 } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /RUNNING/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /FINISHED/ }))?.text).toBe(' FINISHED · 1')
  expect(await ui.find({ type: 'Text', text: /done · 1m 12s/ })).toBeDefined()
  await ui.unmount()
})

test('clear removes the finished agents and their files', async ($, on) => {
  engine(on)
  await spawnAndWork($)
  await $.turn.complete({ turnId: 't1', agentId: 'agent-1', reason: 'error', answer: '', durationMs: 5_000 } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /failed · 5s/ })).toBeDefined()
  await ui.press({ key: 'clear-finished' })
  await ui.unmount()

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /No subagents yet/ }))?.text).toBe('No subagents yet.')
  expect(await after.find({ type: 'Text', text: /parse\.rs/ })).toBeUndefined()
  await after.unmount()
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

// Ending, clearing, time and cost

test('an ending agent is announced, and the status line follows the agents', async ($, on) => {
  const seen = engine(on)
  await spawnAndWork($)
  expect(seen.statuses.at(-1)).toBe('⚙ 1 running · 0 finished')
  await $.turn.complete({ turnId: 't1', agentId: 'agent-1', reason: 'answer', answer: 'ok', durationMs: 72_000 } as never)
  expect(seen.toasts).toContain('✓ Fix the parser: done in 1m 12s')
  expect(seen.statuses.at(-1)).toBe('⚙ 0 running · 1 finished')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'clear-finished' })
  await ui.unmount()
  expect(seen.statuses.at(-1)).toBe(undefined)
})

test('with notify off no notice is shown', { options: { notify: 'off' } }, async ($, on) => {
  const seen = engine(on)
  await spawnAndWork($)
  await $.turn.complete({ turnId: 't1', agentId: 'agent-1', reason: 'answer', answer: 'ok', durationMs: 10 } as never)
  expect(seen.toasts.some(t => t.includes('Fix the parser'))).toBe(false)
})

test('a finished agent leaves the pane after clearAfterMinutes', { options: { clearAfterMinutes: 2 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on, [], { clock: false })
  await spawnAndWork($)
  await $.turn.complete({ turnId: 't1', agentId: 'agent-1', reason: 'answer', answer: 'ok', durationMs: 10 } as never)
  await clock.advance(60_000)
  const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await before.find({ type: 'Text', text: /FINISHED/ })).toBeDefined()
  await before.unmount()

  await clock.advance(60_000)
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await after.unmount()
})

test("a running agent's time moves on its own", async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on, [], { clock: false })
  await spawnAndWork($)
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / · 5s$/ })).toBeDefined()
  await ui.unmount()
})

test('the pane shows what an agent cost by the prices of config.json', async ($, on) => {
  engine(on)
  await spawnAndWork($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // sonnet 5.5: 1000 input at $2/M and 200 output at $10/M.
  expect(await ui.find({ type: 'Text', text: /1\.2k tokens · ≈ \$0\.004/ })).toBeDefined()
  await ui.unmount()
})

test('the status line, the expiry and the dollars are written as expected', () => {
  const row = (id: string, status: AgentRow['status'], durationMs?: number): AgentRow => ({
    id, description: id, type: 't', model: '', effort: '', status, startedAt: 0, tokens: 0, ...(durationMs === undefined ? {} : { durationMs }),
  })
  expect(statusText([])).toBe(undefined)
  expect(statusText([row('a', 'running'), row('b', 'done')])).toBe('⚙ 1 running · 1 finished')
  const rows = [row('a', 'running'), row('old', 'done', 1000), row('new', 'failed', 9 * 60_000)]
  expect(expiredAgents(rows, 10 * 60_000, 5)).toEqual(['old'])
  expect(expiredAgents(rows, 10 * 60_000, 0)).toEqual([])
  expect(shortDollars(1.234)).toBe('$1.23')
  expect(shortDollars(0.0042)).toBe('$0.0042')
  expect(shortDollars(0.5)).toBe('$0.5')
})

test('the report says what the agents cost and what they would on gearbox\'s picks', () => {
  const prices = { haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }
  const usage = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 }
  const lines = [
    { kind: 'spawn', agentId: 'b', recommended: 'haiku:low', ranOn: 'claude-opus-5-5', why: ['search, Trivial'], laya: { work: {} } },
    { kind: 'end', agentId: 'b', reason: 'answer', tokens: 1_100_000, usage },
  ]
  const text = summarize(lines, ['haiku', 'sonnet', 'opus'], 'all sessions', prices)
  // opus: $4 + $2 = $6; haiku: $0.1 + $0.05 = $0.15.
  expect(text).toContain("using 1.1M tokens ≈ $6.00; the same tokens on gearbox's picks ≈ $0.15.")
  expect(text).toContain("Estimated spend: ≈ $6.00 at list prices; on gearbox's picks ≈ $0.15.")
})
