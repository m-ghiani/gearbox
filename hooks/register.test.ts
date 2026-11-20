import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { choose, layaArgv, layaState, parseConfig, parseLaya, signalsOf, upOnTie } from './policy'
import type { Config, LayaAnswers } from './policy'

import { CONFIG_JSON } from './fixture'

function config(): Config {
  const parsed = parseConfig(CONFIG_JSON)
  if (!parsed.config) {
    throw new Error(parsed.error)
  }
  return parsed.config
}

const QUIET = { multiCrate: false, unsafe: false, concurrency: false, security: false, data: false }

function answers(work: Record<string, number>, difficulty: number[], risk = 0.1): LayaAnswers {
  return { work: { search: 0, review: 0, implement: 0, diagnose: 0, architecture: 0, ...work }, difficulty, risk }
}

// What `ollama run laya --format json` printed for a real brief, spinner codes before it.
const OLLAMA_OUT =
  '\u001b[?25l\u001b[1G\u001b[K{"model":"laya","answers":{' +
  '"q1":{"type":"choice","choice":"diagnose","probabilities":{"search":0.015,"implement":0.073,"review":0.37,"diagnose":0.399,"architecture":0.143},"confidence":0.21},' +
  '"q2":{"type":"score","score":1.72,"legend":{"0":"Trivial","1":"Routine","2":"Hard","3":"Very hard"},"probabilities":{"0":0.025,"1":0.284,"2":0.639,"3":0.052},"confidence":0.36},' +
  '"q3":{"type":"noul","noul":0.128}},"usage":{"input_tokens":288,"output_tokens":0}}'

const BRIEF =
  'The borrow checker fails in crates/engine and crates/net after moving the pool to Arc<Mutex<>>; ' +
  'intermittent deadlock under tokio. Find the cause and propose a fix across both crates.'

type Options = { stdout?: string; fail?: boolean; configText?: string; gitStatus?: string[] }

// Nothing sits below the mod: these hooks play the engine.
function engine(on: On, options: Options = {}) {
  const seen = {
    log: '',
    path: '',
    toasts: [] as string[],
    calls: [] as { argv: readonly string[]; stdin?: string }[],
    spawnedWith: [] as (string | undefined)[],
    // What happened first: the spawn or the question to Laya.
    order: [] as string[],
  }
  const gitStatus = [...(options.gitStatus ?? [])]
  on('clock.now', () => ({ value: 0 }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: seen.log !== '' }))
  on('fs.read', (_, e) => ({
    value: (String(e.path).endsWith('config.json') ? (options.configText ?? JSON.stringify(CONFIG_JSON)) : seen.log) as never,
  }))
  on('fs.write', (_, e) => {
    seen.path = e.path
    seen.log = e.text
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      // rev-parse answers the root; each status answers the next of options.gitStatus.
      const stdout = e.argv.includes('rev-parse') ? '/project\n' : (gitStatus.shift() ?? '')
      return { value: { exitCode: 0, stdout, stderr: '' } as never }
    }
    seen.order.push('laya')
    seen.calls.push({ argv: e.argv, stdin: e.init?.stdin })
    if (options.fail) {
      return { deny: 'ollama: command not found' }
    }
    return { value: { exitCode: 0, stdout: options.stdout ?? OLLAMA_OUT, stderr: '' } as never }
  })
  on('agent.spawn', (_, e) => {
    seen.order.push('spawn')
    seen.spawnedWith.push(e.model)
    return { model: e.model ?? e.parentModel, agentId: 'agent-1' }
  })
  on('turn.step', async function* (_, e) {
    const usage = { model: e.model, input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', () => ({ result: {} }))
  return seen
}

async function spawn($: any, fields: object = {}) {
  return $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: BRIEF,
    description: 'Fix the pool deadlock',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...fields,
  })
}

function lines(log: string) {
  return log.trim().split('\n').map(l => JSON.parse(l))
}

// The policy, from config.json

test('a valid config is read whole', () => {
  const c = config()
  expect(c.table.diagnose?.[2]).toEqual({ model: 'opus', effort: 'high' })
  expect(c.floors[1]?.exceptWork).toEqual(['search'])
})

test('a broken config is refused with the place it breaks', () => {
  const bad = (patch: object) => parseConfig({ ...CONFIG_JSON, ...patch }).error
  expect(bad({ table: { ...CONFIG_JSON.table, search: ['haiku:low'] } })).toContain('table.search: 4 gears expected')
  expect(bad({ table: { ...CONFIG_JSON.table, review: ['gpt:low', 'a:b', 'c:d', 'e:f'] } })).toContain('"gpt" is not one of models')
  expect(bad({ table: { ...CONFIG_JSON.table, review: ['opus:turbo', 'a:b', 'c:d', 'e:f'] } })).toContain('"turbo" is not an effort')
  expect(bad({ signals: { ...CONFIG_JSON.signals, unsafe: { pattern: '(' } } })).toContain('signals.unsafe: not a valid regular expression')
  expect(bad({ floors: [{ name: 'x', when: ['nope'], atLeast: 'opus:high' }] })).toContain('"nope" is not one of')
  expect(bad({ fallback: { work: 'nap', difficulty: 1 } })).toContain('fallback.work')
  expect(parseConfig(null).error).toContain('an object is expected')
})

test("reads Ollama's answer even with terminal codes around it", () => {
  const a = parseLaya(config(), OLLAMA_OUT)
  expect(a?.work.diagnose).toBe(0.399)
  expect(a?.difficulty).toEqual([0.025, 0.284, 0.639, 0.052])
  expect(a?.risk).toBe(0.128)
  expect(parseLaya(config(), 'Error: model not found')).toBe(null)
  expect(parseLaya(config(), '{"answers":{"q1":{}}}')).toBe(null)
})

test('a near tie goes to the more demanding option', () => {
  expect(upOnTie([0.1, 0.5, 0.4], 0.15)).toBe(2)
  expect(upOnTie([0.1, 0.7, 0.2], 0.15)).toBe(1)
})

test('searching is cheap, diagnosing is not', () => {
  expect(choose(config(), answers({ search: 0.9 }, [0.8, 0.2, 0, 0]), QUIET).gear).toEqual({ model: 'haiku', effort: 'low' })
  expect(choose(config(), answers({ diagnose: 0.9 }, [0, 0.1, 0.8, 0.1]), QUIET).gear).toEqual({ model: 'opus', effort: 'high' })
})

test('code-writing work never goes below Sonnet', () => {
  expect(choose(config(), answers({ implement: 0.9 }, [0.9, 0.1, 0, 0]), QUIET).gear.model).toBe('sonnet')
})

test('a costly mistake raises the floor to Opus medium', () => {
  const routine = answers({ implement: 0.9 }, [0, 0.9, 0.1, 0])
  expect(choose(config(), routine, QUIET).gear).toEqual({ model: 'sonnet', effort: 'high' })
  expect(choose(config(), routine, { ...QUIET, security: true }).gear).toEqual({ model: 'opus', effort: 'medium' })
  const byLaya = choose(config(), { ...routine, risk: 0.8 }, QUIET)
  expect(byLaya.gear).toEqual({ model: 'opus', effort: 'medium' })
  expect(byLaya.why).toContain('costly mistake: at least opus:medium')
})

test('work across several crates runs at least on Opus high, a search does not', () => {
  const s = signalsOf(config(), BRIEF)
  expect(s.multiCrate).toBe(true)
  expect(s.concurrency).toBe(true)
  expect(choose(config(), answers({ implement: 0.9 }, [0, 0.9, 0.1, 0]), s).gear).toEqual({ model: 'opus', effort: 'high' })
  expect(signalsOf(config(), 'look in crates/engine and again in crates/engine').multiCrate).toBe(false)
  const search = choose(config(), answers({ search: 0.9 }, [0.9, 0.1, 0, 0]), { ...QUIET, multiCrate: true })
  expect(search.gear).toEqual({ model: 'haiku', effort: 'low' })
})

test('without Laya the rules alone decide, from the fallback', () => {
  const pick = choose(config(), null, QUIET)
  expect(pick.gear).toEqual({ model: 'sonnet', effort: 'high' })
  expect(pick.why[0]).toContain('rules only')
})

test('the questions and their options come from the config', () => {
  const argv = layaArgv(config(), 'ollama', 'laya')
  expect(argv).toContain('search=Search, read or list files without changing them')
  expect(argv.filter(a => a === '--ask').length).toBe(3)
  expect(argv.filter(a => a === '--level').length).toBe(4)
  expect(layaState(config(), 'Explore', 'Find it', 'x'.repeat(5000)).length).toBeLessThan(1100)
})

// The mod in a session

test('observing, the subagent runs on what it asked for, and the choice is logged', async ($, on) => {
  const seen = engine(on)
  await spawn($, { model: 'sonnet' })

  expect(seen.spawnedWith).toEqual(['sonnet'])
  const [line] = lines(seen.log)
  expect(line).toMatchObject({
    kind: 'spawn',
    cwd: '/project',
    agentId: 'agent-1',
    requestedModel: 'sonnet',
    ranOn: 'sonnet',
    prompt: BRIEF,
    recommended: 'opus:high',
  })
  expect(line.laya.work.diagnose).toBe(0.399)
  expect(seen.path).toBe('/home/test/.claude/mods/gearbox/test-session/agent-1.jsonl')
})

test('the brief reaches Laya on stdin, never in the command line', async ($, on) => {
  const seen = engine(on)
  await spawn($)

  const [call] = seen.calls
  expect(call?.argv.slice(0, 3)).toEqual(['ollama', 'run', 'laya'])
  expect(call?.argv.some(a => a.includes('borrow checker'))).toBe(false)
  expect(call?.stdin).toContain('borrow checker')
})

test('if Ollama is missing the subagent starts anyway and the error is logged', async ($, on) => {
  const seen = engine(on, { fail: true })
  await spawn($)

  expect(seen.spawnedWith).toEqual([undefined])
  const [line] = lines(seen.log)
  expect(line.laya).toBe(null)
  expect(line.error).toContain('command not found')
  expect(line.why[0]).toContain('rules only')
})

test('with an invalid config.json the mod says so and leaves subagents alone', async ($, on) => {
  const seen = engine(on, { configText: '{ "models": ' })
  await spawn($)

  expect(seen.spawnedWith).toEqual([undefined])
  expect(seen.calls.length).toBe(0)
  expect(seen.log).toBe('')
  expect(seen.toasts.some(t => t.includes('config.json is invalid'))).toBe(true)
})

test('forks, resumes and workflow agents are not assessed', async ($, on) => {
  const seen = engine(on)
  await spawn($, { fork: true })
  await spawn($, { workflow: { runId: 'wf_1', agentIndex: 1 } })
  expect(seen.calls.length).toBe(0)
  expect(seen.log).toBe('')
})

test("the subagent's first step logs the effort it really ran at", async ($, on) => {
  const seen = engine(on)
  await spawn($)
  for (const index of [0, 1]) {
    const stream = $.turn.step({ turnId: 't1', index, messageCount: 1, model: 'claude-sonnet-5-5', effort: 'medium', agentId: 'agent-1' })
    for await (const _ of stream) {
      // no chunks: the fake engine's answer is empty
    }
  }
  const all = lines(seen.log)
  expect(all.length).toBe(2)
  expect(all[1]).toMatchObject({ kind: 'step', agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('observing, the subagent starts before Laya is asked', async ($, on) => {
  const seen = engine(on)
  await spawn($)
  expect(seen.order).toEqual(['spawn', 'laya'])
})

test('applying, the subagent starts on the model gearbox picked', { options: { mode: 'apply' } }, async ($, on) => {
  const seen = engine(on, { fail: true })
  await spawn($)
  // Without Laya the rules decide, and the brief's two crates raise it to opus:high; a spawn
  // takes the model alone.
  expect(seen.order).toEqual(['laya', 'spawn'])
  expect(seen.spawnedWith).toEqual(['opus'])
  expect(lines(seen.log)[0]).toMatchObject({ mode: 'apply', applied: true, recommended: 'opus:high' })
})

test('applying, a model the caller named stands', { options: { mode: 'apply' } }, async ($, on) => {
  const seen = engine(on, { fail: true })
  await spawn($, { model: 'haiku' })
  expect(seen.spawnedWith).toEqual(['haiku'])
  expect(lines(seen.log)[0]).toMatchObject({ applied: false })
})

test("an assessed subagent's end is logged with its outcome and tokens", async ($, on) => {
  const seen = engine(on)
  await spawn($)
  const stream = $.turn.step({ turnId: 't1', index: 0, messageCount: 1, model: 'claude-sonnet-5-5', effort: 'medium', agentId: 'agent-1' })
  for await (const _ of stream) {
    // no chunks
  }
  await $.turn.complete({ turnId: 't1', agentId: 'agent-1', reason: 'answer', answer: 'ok', durationMs: 4200, isAborted: false } as never)
  const end = lines(seen.log).find(l => l.kind === 'end')
  expect(end).toMatchObject({ agentId: 'agent-1', reason: 'answer', durationMs: 4200, tokens: 1200 })
})

test('after the start, Laya is warmed up and only stale logs of other sessions are removed', async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const clock = mock.clock(on, { now: 100 * day })
  const runs: (readonly string[])[] = []
  on('command.register', () => ({ value: { command: 'gearbox' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify(CONFIG_JSON) as never }))
  on('fs.list', () => ({
    value: [
      { name: 'old-session', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'test-session', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'recent.jsonl', kind: 'file', size: 10, mtimeMs: 99 * day, isLink: false },
    ] as never,
  }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 10 * day, isLink: false } as never }))
  on('process.run', (_, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: OLLAMA_OUT, stderr: '' } as never }
  })

  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()

  expect(runs.some(argv => argv[1] === 'run' && argv[2] === 'laya')).toBe(true)
  expect(runs.filter(argv => argv[0] === 'rm')).toEqual([['rm', '-rf', '--', '/home/test/.claude/mods/gearbox/old-session']])
})
