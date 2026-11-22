import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { addAgent, addUsage, cut, expiredAgents, fileOf, fileTree, gitChanges, NO_USAGE, noteFile, parseGitStatus, patchAgent, shortCount, shortDollars, shortDuration, shortModel, statusText } from './agents'
import { staleLogs } from './logs'
import { askedEffort, choose, costOf, EFFORTS, gearName, layaArgv, layaState, mergeConfig, parseConfig, parseLaya, signalsOf } from './policy'
import type { Config, LayaAnswers, Pick } from './policy'
import { summarize } from './report'
import type { AgentRow, AgentStatus, Effort, FileOp, Usage } from '../types'

// For each subagent gearbox asks Laya (a local decision model in Ollama) what the work is,
// turns the answers into a model and an effort with config.json, and logs that next to what
// the subagent ran on and how it ended. In `observe` mode (the default) it changes nothing:
// the log is the evaluation set that `/gearbox report` reads. In `apply` mode it starts the
// subagent on the model it picked, and sets the effort it picked on each of its steps.
//
// The agents pane shows every subagent of the session, the model and effort it runs on, what
// gearbox would have picked, its tokens and time; hovering an agent, or selecting it, shows
// the files it read and changed as a tree.

const disabled = atom({ plugin: 'gearbox', key: 'disabled' } as const, false)
// Change a tag when its value's fields change: it declines what an earlier version stored.
const agents = atom({ plugin: 'gearbox', key: 'agents' } as const, [], { shape: 'agents-2' })
const files = atom({ plugin: 'gearbox', key: 'files' } as const, {}, { shape: 'files-2' })
const selected = atom({ plugin: 'gearbox', key: 'selected' } as const, '')
// The effort above high the person's latest prompt asked for, '' for none.
const asked = atom({ plugin: 'gearbox', key: 'askedEffort' } as const, '')
// The effort above high /gearbox effort set for the session, '' for none.
const effortOverride = atom({ plugin: 'gearbox', key: 'effortOverride' } as const, '')
// Bumped each second while an agent runs: the pane reads it, so its times move.
const tick = atom({ plugin: 'gearbox', key: 'tick' } as const, 0)

const PANE = 'gearbox-agents'
const PANE_TITLE = 'Agents'
const GIT_TIMEOUT_MS = 3000
// A project's own policy, over config.json, relative to the session's directory.
const PROJECT_POLICY = '.claude/gearbox.json'
// Laya's answers kept for briefs seen before; the oldest leave first.
const LAYA_CACHE_SIZE = 100

type Mode = 'observe' | 'apply'

// The options, as this activation received them.
let ollamaPath = 'ollama'
let layaModel = 'laya'
let mode: Mode = 'observe'
let retentionDays = 30
let notify = true
let clearAfterMinutes = 0

// config.json, and the project's .claude/gearbox.json over it, read once per load: editing
// either reloads nothing until the mod reloads.
let loaded: { config: Config; error?: undefined } | { config?: undefined; error: string } | null = null
// The project policy in use, '' for none.
let projectPolicy = ''

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch (err) {
    throw new Error(`${path}: ${err instanceof SyntaxError ? 'not valid JSON' : 'not readable'} (${err instanceof Error ? err.message : String(err)})`)
  }
}

// The project policy's path when the session's directory has one; null otherwise, and when
// the directory cannot be asked (the shipped policy then stands alone).
async function projectPolicyPath($: EngineInterface): Promise<string | null> {
  try {
    const path = `${await $.session.cwd()}/${PROJECT_POLICY}`
    return (await $.fs.exists(path)) ? path : null
  } catch (err) {
    $.ui.log(`gearbox: no project policy looked for (${String(err).slice(0, 200)})`, { to: 'debug' })
    return null
  }
}

async function configOf($: EngineInterface): Promise<Config | null> {
  if (loaded === null) {
    projectPolicy = ''
    try {
      let raw = await readJson($, `${$.plugin.root}/config.json`)
      const project = await projectPolicyPath($)
      if (project) {
        raw = mergeConfig(raw, await readJson($, project))
        projectPolicy = project
      }
      const parsed = parseConfig(raw)
      loaded = parsed.error !== undefined && projectPolicy ? { error: `${parsed.error} (config.json with ${projectPolicy} over it)` } : parsed
    } catch (err) {
      loaded = { error: err instanceof Error ? err.message : String(err) }
    }
    if (loaded.config && projectPolicy) {
      // A cloned repository can change what subagents run on: say so where it shows.
      $.ui.toast(`gearbox: using the project policy ${PROJECT_POLICY}`)
    }
    if (loaded.error !== undefined) {
      // Without a policy there is nothing to assess: subagents start untouched.
      $.ui.toast(`gearbox is off: config.json is invalid. /gearbox says why.`)
      $.ui.log(`gearbox: ${loaded.error}`, { to: 'debug' })
    }
  }
  return loaded.config ?? null
}

// The logs: one folder per session, one file per subagent, so a write rereads a few lines,
// never the session's whole log.
async function logRoot($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  return `${dir}/mods/gearbox`
}

async function sessionLogDir($: EngineInterface): Promise<string> {
  return `${await logRoot($)}/${await $.session.id()}`
}

// $.fs has no append: a line is the file written whole. What each agent's file holds is kept
// here, so a line is never preceded by a read; only an agent logged before a reload is read
// back, once. Writes go one at a time, so two lines for one agent never overwrite each other.
let writing: Promise<void> = Promise.resolve()
const logged = new Map<string, string>()

function record($: EngineInterface, agentId: string, entry: Record<string, unknown>): Promise<void> {
  writing = writing.then(async () => {
    try {
      const path = `${await sessionLogDir($)}/${agentId}.jsonl`
      const before = logged.get(agentId) ?? ((await $.fs.exists(path)) ? String(await $.fs.read(path)) : '')
      const line = { time: new Date(await $.clock.now()).toISOString(), agentId, ...entry }
      const text = `${before}${JSON.stringify(line)}\n`
      await $.fs.write(path, text)
      logged.set(agentId, text)
    } catch (err) {
      $.ui.log(`gearbox: log not written (${String(err)})`, { to: 'debug' })
    }
  })
  return writing
}

async function isLogged($: EngineInterface, agentId: string): Promise<boolean> {
  return logged.has(agentId) || $.fs.exists(`${await sessionLogDir($)}/${agentId}.jsonl`)
}

async function askLaya($: EngineInterface, config: Config, state: string): Promise<{ answers: LayaAnswers | null; error?: string }> {
  try {
    const r = await $.process.run(layaArgv(config, ollamaPath, layaModel), { stdin: state, timeoutMs: config.laya.timeoutMs })
    if (r.exitCode !== 0) {
      return { answers: null, error: `exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}` }
    }
    const answers = parseLaya(config, r.stdout)
    return answers ? { answers } : { answers: null, error: 'unreadable answer' }
  } catch (err) {
    return { answers: null, error: String(err).slice(0, 200) }
  }
}

type Assessment = { pick: Pick; signals: Record<string, boolean>; answers: LayaAnswers | null; error?: string; cached: boolean; ms: number }

// Laya answers the same brief the same way: a brief seen before is not asked again. Failures
// are not kept, so a missing Ollama is tried again on the next brief.
const layaCache = new Map<string, LayaAnswers>()

async function cachedLaya($: EngineInterface, config: Config, state: string): Promise<{ answers: LayaAnswers | null; error?: string; cached: boolean }> {
  const known = layaCache.get(state)
  if (known) {
    return { answers: known, cached: true }
  }
  const asked_ = await askLaya($, config, state)
  if (asked_.answers) {
    layaCache.set(state, asked_.answers)
    while (layaCache.size > LAYA_CACHE_SIZE) {
      const oldest = layaCache.keys().next()
      if (oldest.done) {
        break
      }
      layaCache.delete(oldest.value)
    }
  }
  return { ...asked_, cached: false }
}

// The effort above high the person asked for: /gearbox effort for the session, else their
// latest prompt.
async function personEffort($: EngineInterface): Promise<Effort | null> {
  const set = await read($, effortOverride)
  if (set !== '') {
    return set
  }
  const said = await read($, asked)
  return said === '' ? null : said
}

async function assess($: EngineInterface, config: Config, subagentType: string, description: string, prompt: string): Promise<Assessment> {
  const startedAt = await $.clock.now()
  const effort = await personEffort($)
  const signals = signalsOf(config, prompt)
  const { answers, error, cached } = await cachedLaya($, config, layaState(config, subagentType, description, prompt))
  const ms = (await $.clock.now()) - startedAt
  return { pick: choose(config, answers, signals, effort), signals, answers, ...(error ? { error } : {}), cached, ms }
}

// Every log line of every session, the folders of 0.2 and the single files of 0.1 alike.
async function readLogs($: EngineInterface, onlySession?: string): Promise<unknown[]> {
  const root = await logRoot($)
  if (!(await $.fs.exists(root))) {
    return []
  }
  const paths: string[] = []
  for (const entry of await $.fs.list(root)) {
    const session = entry.name.replace(/\.jsonl$/, '')
    if (onlySession && session !== onlySession) {
      continue
    }
    if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
      paths.push(`${root}/${entry.name}`)
    } else if (entry.kind === 'dir') {
      for (const f of await $.fs.list(`${root}/${entry.name}`)) {
        if (f.kind === 'file' && f.name.endsWith('.jsonl')) {
          paths.push(`${root}/${entry.name}/${f.name}`)
        }
      }
    }
  }
  const lines: unknown[] = []
  for (const path of paths) {
    for (const text of String(await $.fs.read(path)).split('\n')) {
      if (text.trim() === '') {
        continue
      }
      try {
        lines.push(JSON.parse(text))
      } catch {
        $.ui.log(`gearbox: an unreadable line in ${path} was skipped`, { to: 'debug' })
      }
    }
  }
  return lines
}

// Removes the logs of other sessions older than retentionDays. $.fs has no delete, so `rm`
// does it, on names staleLogs checked, under the log folder only.
async function pruneLogs($: EngineInterface): Promise<void> {
  const root = await logRoot($)
  if (retentionDays <= 0 || !(await $.fs.exists(root))) {
    return
  }
  const entries = await Promise.all(
    (await $.fs.list(root)).map(async e => ({
      name: e.name,
      isLink: e.isLink,
      // A listing gives a file's time only: a session's folder is asked for its own.
      mtimeMs: e.kind === 'dir' ? (await $.fs.stat(`${root}/${e.name}`)).mtimeMs : e.mtimeMs,
    })),
  )
  for (const name of staleLogs(entries, await $.clock.now(), retentionDays, await $.session.id())) {
    const r = await $.process.run(['rm', '-rf', '--', `${root}/${name}`], { timeoutMs: 10_000 })
    if (r.exitCode !== 0) {
      $.ui.log(`gearbox: ${root}/${name} not removed (${r.stderr.trim().slice(0, 200)})`, { to: 'debug' })
    }
  }
}

// The first call loads Laya into Ollama, which can take longer than the timeout: made once
// at the start, with a brief of no consequence, so the first real subagent finds it loaded.
async function warmLaya($: EngineInterface): Promise<void> {
  const config = await configOf($)
  if (config) {
    const { error } = await askLaya($, config, layaState(config, 'Explore', 'Warm up', 'List the files in src/.'))
    if (error) {
      $.ui.log(`gearbox: Laya did not warm up (${error})`, { to: 'debug' })
    }
  }
}

// `git status` of the repository a directory is in, by path from the repository's root; null
// where there is no repository or git is missing.
async function gitStatus($: EngineInterface, cwd: string): Promise<{ root: string; status: Map<string, string> } | null> {
  try {
    const top = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
    if (top.exitCode !== 0) {
      return null
    }
    const st = await $.process.run(['git', '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: GIT_TIMEOUT_MS })
    return st.exitCode === 0 ? { root: top.stdout.trim(), status: parseGitStatus(st.stdout) } : null
  } catch (err) {
    $.ui.log(`gearbox: git status failed in ${cwd} (${String(err).slice(0, 200)})`, { to: 'debug' })
    return null
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: PANE_TITLE })
}

const STATUS_OF: Record<string, AgentStatus> = { answer: 'done', aborted: 'stopped' }

// How a status reads in the pane: a finished agent says how it ended in words and in colour,
// so it cannot be taken for one still at work.
const GLYPH: Record<AgentStatus, { text: string; label: string; color: string }> = {
  running: { text: '●', label: 'running', color: 'claude' },
  done: { text: '✓', label: 'done', color: 'success' },
  stopped: { text: '■', label: 'stopped', color: 'warning' },
  failed: { text: '✗', label: 'failed', color: 'error' },
}

const BADGE: Record<FileOp, { text: string; color: string }> = {
  edit: { text: 'M', color: 'warning' },
  write: { text: 'W', color: 'success' },
  shell: { text: 'B', color: 'suggestion' },
  read: { text: 'R', color: 'subtle' },
}

const TIER_COLOR: Record<string, string> = { opus: 'claude', sonnet: 'suggestion', haiku: 'success' }

// Tree lines shown under one agent; past this a line says how many more.
const MAX_TREE_LINES = 25

// Whether the subagent runs on what gearbox would have picked: same model family, same effort.
function matches(row: AgentRow): boolean {
  if (!row.recommended || !row.model) {
    return true
  }
  const [model = '', effort = ''] = row.recommended.split(':')
  return row.model.includes(model) && (row.effort === '' || row.effort === effort)
}

async function refreshStatus($: EngineInterface): Promise<void> {
  $.ui.status(statusText(await read($, agents)))
}

// Takes finished agents, and their files, out of the pane; the logs keep them.
async function removeAgents($: EngineInterface, ids: readonly string[]): Promise<void> {
  const gone = new Set(ids)
  await update($, agents, all => all.filter(r => !(gone.has(r.id) && r.status !== 'running')))
  await update($, files, all => Object.fromEntries(Object.entries(all).filter(([id]) => !gone.has(id))))
  await update($, selected, s => (gone.has(s) ? '' : s))
  await refreshStatus($)
}

// One timer while any agent runs: it moves the pane's times and stops with the last agent.
let ticking: { cancel: () => void } | null = null

function ensureTick($: EngineInterface): void {
  if (ticking) {
    return
  }
  ticking = $.clock.every(1000, () => {
    void (async () => {
      if ((await read($, agents)).some(r => r.status === 'running')) {
        await update($, tick, n => n + 1)
      } else {
        ticking?.cancel()
        ticking = null
      }
    })().catch(err => $.ui.log(`gearbox: pane tick failed (${String(err)})`, { to: 'debug' }))
  })
}

function usageOf(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null | undefined): Usage {
  return u ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens } : NO_USAGE
}

export const register: Register = (on, options) => {
  ollamaPath = String(options.ollama ?? 'ollama').trim() || 'ollama'
  layaModel = String(options.model ?? 'laya').trim() || 'laya'
  mode = options.mode === 'apply' ? 'apply' : 'observe'
  const days = Number(options.retentionDays ?? 30)
  retentionDays = Number.isFinite(days) && days >= 0 ? days : 30
  notify = options.notify !== 'off'
  const minutes = Number(options.clearAfterMinutes ?? 0)
  clearAfterMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0
  loaded = null
  logged.clear()
  layaCache.clear()
  ticking?.cancel()
  ticking = null

  // Subagents assessed at spawn: their first step says which effort they really ran at.
  const awaitingStep = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gearbox',
      description: 'Subagent model and effort: on, off, effort, agents (the pane), report, or status',
      argumentHint: '[on|off|effort xhigh|max|auto|agents|report [session]]',
    })
    await configOf($)
    void openPane($).catch(err => $.ui.log(`gearbox: pane not opened (${String(err)})`, { to: 'debug' }))
    // After a reload: agents still running keep the clock, ones finished long ago leave.
    const rows = await read($, agents)
    if (rows.some(r => r.status === 'running')) {
      ensureTick($)
    }
    await removeAgents($, expiredAgents(rows, await $.clock.now(), clearAfterMinutes))
    // After the start, on a timer: neither the warm-up nor the pruning holds the session up.
    $.clock.after(0, () => {
      void warmLaya($).catch(err => $.ui.log(`gearbox: warm-up failed (${String(err)})`, { to: 'debug' }))
      void pruneLogs($).catch(err => $.ui.log(`gearbox: old logs not pruned (${String(err)})`, { to: 'debug' }))
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear starts another conversation: its agents are not this one's.
    if (e.reason === 'clear') {
      await update($, agents, () => [])
      await update($, files, () => ({}))
      await update($, selected, () => '')
      await update($, effortOverride, () => '')
      await refreshStatus($)
    }
    return next(e)
  })

  // An effort above high is the person's call: only a prompt they typed can ask for it, and
  // each new one asks again.
  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta) {
      await update($, asked, () => askedEffort(e.text) ?? '')
    }
    return next(e)
  }).catch((_, e, next) => (next.called ? undefined : next(e)))

  on('command.run', { command: 'gearbox' }, async ($, e) => {
    const [arg = '', scope = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (arg === 'off' || arg === 'on') {
      await update($, disabled, () => arg === 'off')
      return { text: arg === 'off' ? 'gearbox off for this session.' : `gearbox on: ${mode === 'apply' ? 'picking models for' : 'observing'} subagents.` }
    }
    if (arg === 'effort') {
      if (scope === 'xhigh' || scope === 'max') {
        await update($, effortOverride, () => scope)
        return { text: `gearbox picks ${scope} effort for every subagent of this session, until /gearbox effort auto.` }
      }
      if (scope === 'auto') {
        await update($, effortOverride, () => '')
        return { text: 'gearbox picks at most high effort again, unless a prompt asks for more.' }
      }
      const set = await read($, effortOverride)
      return { text: `${set ? `Effort set to ${set} for this session.` : 'Effort: gearbox picks at most high.'} /gearbox effort xhigh|max sets it for the session, /gearbox effort auto lets gearbox pick.` }
    }
    if (arg === 'agents' || arg === 'pane') {
      const opened = await openPane($)
      return { text: opened.isPlaced ? 'Agents pane opened. Hover an agent, or select it, to see its files.' : 'The agents pane opens once the terminal is wide enough.' }
    }
    const config = await configOf($)
    if (arg === 'report') {
      if (!config) {
        return { text: `gearbox cannot report: ${loaded?.error ?? 'no policy'}` }
      }
      const session = scope === 'session' ? await $.session.id() : undefined
      return { text: summarize(await readLogs($, session), config.models, session ? 'this session' : 'all sessions', config.prices) }
    }
    if (loaded?.error !== undefined) {
      return { text: `gearbox is off: ${loaded.error}` }
    }
    const state = (await read($, disabled)) ? 'off' : mode === 'apply' ? 'on, applying its model picks' : 'on, observing (it changes nothing)'
    const keep = retentionDays > 0 ? `kept ${retentionDays} days` : 'kept forever'
    const policy = `${$.plugin.root}/config.json${projectPolicy ? `, with ${projectPolicy} over it` : ''}`
    const effort = await read($, effortOverride)
    return {
      text: `gearbox ${state}${effort ? `, effort ${effort} for this session` : ''}. Policy: ${policy}. Laya: ${ollamaPath} run ${layaModel}. Logs: ${await sessionLogDir($)} (${keep}).`,
    }
  })

  on('agent.spawn', async ($, e, next) => {
    // A fork inherits its parent's model, a resume keeps its own, and a workflow agent's
    // prompt may be a placeholder: none of them is a choice to assess. They still show in
    // the pane.
    const config = e.fork || e.resume || e.workflow || (await read($, disabled)) ? null : await configOf($)

    // Applying, the pick must be known before the subagent starts. Observing, it starts at
    // once and Laya is asked while it runs.
    let assessed: Assessment | null = config && mode === 'apply' ? await assess($, config, e.subagentType, e.description, e.prompt) : null
    // A model the caller asked for stands: the pick only fills in where none was given.
    const applied = assessed !== null && e.model === undefined
    const started = await next(assessed && applied ? { ...e, model: assessed.pick.gear.model } : e)

    const agentId = 'deny' in started ? undefined : started.agentId
    if (agentId) {
      const now = await $.clock.now()
      if (e.resume) {
        await update($, agents, rows => patchAgent(rows, agentId, { status: 'running' }))
      } else {
        await update($, agents, rows =>
          addAgent(rows, {
            id: agentId,
            description: e.description,
            type: e.name ?? e.subagentType,
            model: 'deny' in started ? '' : started.model,
            effort: '',
            ...(assessed ? { recommended: gearName(assessed.pick.gear) } : {}),
            ...(applied ? { applied: true } : {}),
            status: 'running',
            startedAt: now,
            tokens: 0,
            ...(e.cwd ? { cwd: e.cwd } : {}),
          }),
        )
      }
      ensureTick($)
      await refreshStatus($)
    }
    if (!config || !agentId) {
      return started
    }

    awaitingStep.add(agentId)
    if (!assessed) {
      assessed = await assess($, config, e.subagentType, e.description, e.prompt)
      const recommended = gearName(assessed.pick.gear)
      await update($, agents, rows => patchAgent(rows, agentId, { recommended }))
    }
    await record($, agentId, {
      kind: 'spawn',
      mode,
      applied,
      cwd: e.cwd ?? (await $.session.cwd()),
      subagentType: e.subagentType,
      description: e.description,
      // The whole brief: these lines are the set the thresholds are measured on.
      prompt: e.prompt,
      requestedModel: e.model ?? null,
      parentModel: e.parentModel,
      ranOn: 'deny' in started ? null : started.model,
      recommended: gearName(assessed.pick.gear),
      why: assessed.pick.why,
      signals: assessed.signals,
      laya: assessed.answers,
      ...(assessed.cached ? { cached: true } : {}),
      ...(assessed.error ? { error: assessed.error } : {}),
      ms: assessed.ms,
    })
    return started
  }).catch((_, e, next) => (next.called ? undefined : next(e))) // the spawn goes on whatever happens here

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const row = id ? (await read($, agents)).find(r => r.id === id) : undefined
    // Applying, a subagent gearbox chose the model of runs at the effort it picked, from its
    // first step on, so its cache is never broken by a change. A model without an effort
    // level (none, or a thinking budget) is left as it is.
    const picked = mode === 'apply' && row?.applied ? row.recommended?.split(':')[1] : undefined
    const effortOf = (EFFORTS as readonly string[]).includes(picked ?? '') && typeof e.effort === 'string' ? (picked as Effort) : undefined
    const step = effortOf ? { ...e, effort: effortOf } : e
    if (id && awaitingStep.delete(id)) {
      await record($, id, { kind: 'step', model: e.model, effort: step.effort ?? null, ...(effortOf ? { defaultEffort: e.effort ?? null } : {}) })
    }
    const result = yield* next(step)
    if (id && row) {
      const effort = step.effort === undefined ? '' : String(step.effort)
      const usage = usageOf(result.usage)
      const used = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
      const config = await configOf($)
      const spent = config ? costOf(config, e.model, usage) : null
      await update($, agents, rows =>
        rows.map(r =>
          r.id === id
            ? {
                ...r,
                model: e.model,
                effort,
                status: 'running' as const,
                tokens: r.tokens + used,
                usage: addUsage(r.usage ?? NO_USAGE, usage),
                ...(spent === null ? {} : { cost: (r.cost ?? 0) + spent }),
              }
            : r,
        ),
      )
    }
    return result
  }).catch(async function* (_, e, next) {
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    if (id) {
      const status = STATUS_OF[e.reason] ?? 'failed'
      await update($, agents, rows => patchAgent(rows, id, { status, durationMs: e.durationMs }))
      const row = (await read($, agents)).find(r => r.id === id)
      if (await isLogged($, id)) {
        await record($, id, {
          kind: 'end',
          reason: e.reason,
          durationMs: e.durationMs,
          tokens: row?.tokens ?? null,
          ...(row?.usage ? { usage: row.usage } : {}),
          ...(row?.cost !== undefined ? { cost: row.cost } : {}),
        })
      }
      if (row && notify) {
        const glyph = GLYPH[status]
        $.ui.toast(`${glyph.text} ${cut(row.description || row.type, 60)}: ${glyph.label} in ${shortDuration(e.durationMs)}`)
      }
      if (clearAfterMinutes > 0) {
        $.clock.after(clearAfterMinutes * 60_000, () => {
          void removeAgents($, [id]).catch(err => $.ui.log(`gearbox: agent not cleared (${String(err)})`, { to: 'debug' }))
        })
      }
      await refreshStatus($)
    }
    return done
  }).catch((_, e, next) => (next.called ? undefined : next(e)))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (!id) {
      return next(e)
    }
    // A Bash command names no file: what it changed is read from git, before and after.
    if (e.tool === 'Bash') {
      const cwd = (await read($, agents)).find(r => r.id === id)?.cwd ?? (await $.session.cwd())
      const before = await gitStatus($, cwd)
      const ran = await next(e)
      const after = before ? await gitStatus($, cwd) : null
      if (before && after) {
        const changed = gitChanges(before.status, after.status)
        if (changed.length > 0) {
          await update($, files, all => ({
            ...all,
            [id]: changed.reduce((list, path) => noteFile(list, `${after.root}/${path}`, 'shell'), all[id] ?? []),
          }))
        }
      }
      return ran
    }
    const ran = await next(e)
    const input: Record<string, unknown> = { ...e }
    const file = fileOf(e.tool, input)
    if (file && ran.deny === undefined && !ran.isError) {
      await update($, files, all => ({ ...all, [id]: noteFile(all[id] ?? [], file.path, file.op) }))
    }
    return ran
  }).catch((_, e, next) => (next.called ? undefined : next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Reading the tick subscribes the pane to it: a running agent's time moves each second.
    const [rows, touched, pinned, cwd, now] = await Promise.all([read($, agents), read($, files), read($, selected), $.session.cwd(), $.clock.now(), read($, tick)])
    const W = Math.max(24, e.props.bodyColumns)
    // Running agents in the order they started; finished ones newest first.
    const running = rows.filter(r => r.status === 'running')
    const finished = rows.filter(r => r.status !== 'running').reverse()

    const clearFinished = async () => removeAgents($, (await read($, agents)).filter(r => r.status !== 'running').map(r => r.id))
    // Tokens, and what they cost where config.json prices the model.
    const spend = (row: AgentRow) => `${shortCount(row.tokens)} tokens${row.cost === undefined ? '' : ` · ≈ ${shortDollars(row.cost)}`}`

    const viewButton = (row: AgentRow) => (
      <Button
        key={`view-${row.id}`}
        plain
        onPress={() =>
          void $.ui.view({ agentId: row.id }).then(r => {
            if (r.deny !== undefined) {
              $.ui.toast(`gearbox: cannot open that agent (${r.deny})`)
            }
          })
        }
      >
        <Text dimColor>↗</Text>
      </Button>
    )

    // The files an agent touched: open while selected, or while the pointer is on the agent.
    const fileList = (row: AgentRow, width: number) => {
      const tree = fileTree(touched[row.id] ?? [], row.cwd ?? cwd)
      return (
        <Box flexDirection="column" {...(pinned === row.id ? {} : { display: 'none' as const, hover: { display: 'flex' as const } })}>
          {tree.length === 0 && <Text dimColor>{'  no files yet'}</Text>}
          {tree.slice(0, MAX_TREE_LINES).map(line => (
            <Text>
              <Text dimColor>{`  ${line.prefix}`}</Text>
              {line.isDir ? (
                <Text color="suggestion">{line.name}</Text>
              ) : (
                <Text>
                  {line.op && <Text color={BADGE[line.op].color}>{`${BADGE[line.op].text} `}</Text>}
                  {cut(line.name, Math.max(8, width - line.prefix.length - 6))}
                  {(line.count ?? 0) > 1 && <Text dimColor>{` ×${line.count}`}</Text>}
                </Text>
              )}
            </Text>
          ))}
          {tree.length > MAX_TREE_LINES && <Text dimColor>{`  … ${tree.length - MAX_TREE_LINES} more`}</Text>}
        </Box>
      )
    }

    const modelText = (row: AgentRow) => {
      const tier = Object.keys(TIER_COLOR).find(t => row.model.includes(t)) ?? ''
      return <Text color={TIER_COLOR[tier] ?? 'text'}>{row.model ? shortModel(row.model) : '…'}</Text>
    }

    // A running agent is a framed card: the one place the eye goes first.
    const runningCard = (row: AgentRow) => {
      const inner = W - 4
      const differs = !matches(row)
      return (
        <Box key={`agent-${row.id}`} flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} hover={{ borderColor: 'text' }}>
          <Box flexDirection="row">
            <Box flexGrow={1}>
              <Button key={`select-${row.id}`} plain onPress={() => void update($, selected, s => (s === row.id ? '' : row.id))}>
                <Text color={GLYPH.running.color}>{GLYPH.running.text}</Text> <Text bold>{cut(row.description || row.type, inner - 4)}</Text>
              </Button>
            </Box>
            {viewButton(row)}
          </Box>
          <Text>
            {'  '}
            {modelText(row)}
            {` · ${row.effort || '…'}`}
            <Text dimColor>{` · ${cut(row.type, Math.max(8, inner - 26))}`}</Text>
          </Text>
          <Text dimColor>{`  ${spend(row)} · ${shortDuration(Math.max(0, now - row.startedAt))}`}</Text>
          {row.recommended && (
            <Text>
              {'  '}
              <Text color={differs ? 'warning' : 'subtle'} bold={differs}>{`⚙ gearbox ${mode === 'apply' ? '✓' : '→'} ${row.recommended}`}</Text>
            </Text>
          )}
          {fileList(row, inner)}
        </Box>
      )
    }

    // A finished agent folds to two lines: how it ended first, then what it ran on.
    const finishedRow = (row: AgentRow) => {
      const glyph = GLYPH[row.status]
      const outcome = `${glyph.label} · ${shortDuration(row.durationMs ?? Math.max(0, now - row.startedAt))}`
      return (
        <Box key={`agent-${row.id}`} flexDirection="column" paddingX={1}>
          <Box flexDirection="row">
            <Box flexGrow={1}>
              <Button key={`select-${row.id}`} plain onPress={() => void update($, selected, s => (s === row.id ? '' : row.id))}>
                <Text color={glyph.color}>{glyph.text}</Text> <Text>{cut(row.description || row.type, W - outcome.length - 8)}</Text>
              </Button>
            </Box>
            <Text color={glyph.color}>{`${outcome} `}</Text>
            {viewButton(row)}
          </Box>
          <Text dimColor>
            {'  '}
            {row.model ? shortModel(row.model) : '…'}
            {` · ${row.effort || '…'} · ${spend(row)}`}
            {row.recommended && !matches(row) ? <Text color="warning">{` · ⚙ ${row.recommended}`}</Text> : ''}
          </Text>
          {fileList(row, W - 2)}
        </Box>
      )
    }

    if (rows.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>No subagents yet.</Text>
          <Text dimColor>Each one shows here as Claude starts it.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {running.length > 0 && (
          <Box flexDirection="column">
            <Text bold color="claude">{` RUNNING · ${running.length}`}</Text>
            {running.map(runningCard)}
          </Box>
        )}
        {finished.length > 0 && (
          <Box flexDirection="column" marginTop={running.length > 0 ? 1 : 0} rowGap={1}>
            <Box flexDirection="row">
              <Box flexGrow={1}>
                <Text bold dimColor>{` FINISHED · ${finished.length}`}</Text>
              </Box>
              <Button key="clear-finished" plain onPress={() => void clearFinished()}>
                <Text dimColor>clear </Text>
              </Button>
            </Box>
            {finished.map(finishedRow)}
          </Box>
        )}
      </Box>
    )
  })
}
