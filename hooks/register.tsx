import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { addAgent, cut, fileOf, fileTree, gitChanges, noteFile, parseGitStatus, patchAgent, shortCount, shortDuration, shortModel } from './agents'
import { staleLogs } from './logs'
import { choose, gearName, layaArgv, layaState, parseConfig, parseLaya, signalsOf } from './policy'
import type { Config, LayaAnswers, Pick } from './policy'
import { summarize } from './report'
import type { AgentRow, AgentStatus, FileOp } from '../types'

// For each subagent gearbox asks Laya (a local decision model in Ollama) what the work is,
// turns the answers into a model and an effort with config.json, and logs that next to what
// the subagent ran on and how it ended. In `observe` mode (the default) it changes nothing:
// the log is the evaluation set that `/gearbox report` reads. In `apply` mode it starts the
// subagent on the model it picked; the effort it can only recommend, as a spawn takes none.
//
// The agents pane shows every subagent of the session, the model and effort it runs on, what
// gearbox would have picked, its tokens and time; hovering an agent, or selecting it, shows
// the files it read and changed as a tree.

const disabled = atom({ plugin: 'gearbox', key: 'disabled' } as const, false)
// Change a tag when its value's fields change: it declines what an earlier version stored.
const agents = atom({ plugin: 'gearbox', key: 'agents' } as const, [], { shape: 'agents-2' })
const files = atom({ plugin: 'gearbox', key: 'files' } as const, {}, { shape: 'files-2' })
const selected = atom({ plugin: 'gearbox', key: 'selected' } as const, '')

const PANE = 'gearbox-agents'
const PANE_TITLE = 'Agents'
const GIT_TIMEOUT_MS = 3000

type Mode = 'observe' | 'apply'

// The options, as this activation received them.
let ollamaPath = 'ollama'
let layaModel = 'laya'
let mode: Mode = 'observe'
let retentionDays = 30

// config.json, read once per load: editing it reloads nothing until the mod reloads.
let loaded: { config: Config; error?: undefined } | { config?: undefined; error: string } | null = null

async function configOf($: EngineInterface): Promise<Config | null> {
  if (loaded === null) {
    const path = `${$.plugin.root}/config.json`
    try {
      loaded = parseConfig(JSON.parse(String(await $.fs.read(path))))
    } catch (err) {
      loaded = { error: `${path}: ${err instanceof SyntaxError ? 'not valid JSON' : 'not readable'} (${err instanceof Error ? err.message : String(err)})` }
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

// $.fs has no append: a line is the file reread and written whole. Writes go one at a time,
// so two lines for one agent (its spawn and its first step) never overwrite each other.
let writing: Promise<void> = Promise.resolve()

function record($: EngineInterface, agentId: string, entry: Record<string, unknown>): Promise<void> {
  writing = writing.then(async () => {
    try {
      const path = `${await sessionLogDir($)}/${agentId}.jsonl`
      const before = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
      const line = { time: new Date(await $.clock.now()).toISOString(), agentId, ...entry }
      await $.fs.write(path, `${before}${JSON.stringify(line)}\n`)
    } catch (err) {
      $.ui.log(`gearbox: log not written (${String(err)})`, { to: 'debug' })
    }
  })
  return writing
}

async function isLogged($: EngineInterface, agentId: string): Promise<boolean> {
  return $.fs.exists(`${await sessionLogDir($)}/${agentId}.jsonl`)
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

type Assessment = { pick: Pick; signals: Record<string, boolean>; answers: LayaAnswers | null; error?: string; ms: number }

async function assess($: EngineInterface, config: Config, subagentType: string, description: string, prompt: string): Promise<Assessment> {
  const startedAt = await $.clock.now()
  const signals = signalsOf(config, prompt)
  const { answers, error } = await askLaya($, config, layaState(config, subagentType, description, prompt))
  const ms = (await $.clock.now()) - startedAt
  return { pick: choose(config, answers, signals), signals, answers, ...(error ? { error } : {}), ms }
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

const GLYPH: Record<AgentStatus, { text: string; color: string }> = {
  running: { text: '●', color: 'success' },
  done: { text: '✓', color: 'subtle' },
  stopped: { text: '■', color: 'subtle' },
  failed: { text: '✗', color: 'error' },
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

export const register: Register = (on, options) => {
  ollamaPath = String(options.ollama ?? 'ollama').trim() || 'ollama'
  layaModel = String(options.model ?? 'laya').trim() || 'laya'
  mode = options.mode === 'apply' ? 'apply' : 'observe'
  const days = Number(options.retentionDays ?? 30)
  retentionDays = Number.isFinite(days) && days >= 0 ? days : 30
  loaded = null

  // Subagents assessed at spawn: their first step says which effort they really ran at.
  const awaitingStep = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gearbox',
      description: 'Subagent model and effort: on, off, agents (the pane), report, or status',
      argumentHint: '[on|off|agents|report [session]]',
    })
    await configOf($)
    void openPane($).catch(err => $.ui.log(`gearbox: pane not opened (${String(err)})`, { to: 'debug' }))
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
    }
    return next(e)
  })

  on('command.run', { command: 'gearbox' }, async ($, e) => {
    const [arg = '', scope = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (arg === 'off' || arg === 'on') {
      await update($, disabled, () => arg === 'off')
      return { text: arg === 'off' ? 'gearbox off for this session.' : `gearbox on: ${mode === 'apply' ? 'picking models for' : 'observing'} subagents.` }
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
      return { text: summarize(await readLogs($, session), config.models, session ? 'this session' : 'all sessions') }
    }
    if (loaded?.error !== undefined) {
      return { text: `gearbox is off: ${loaded.error}` }
    }
    const state = (await read($, disabled)) ? 'off' : mode === 'apply' ? 'on, applying its model picks' : 'on, observing (it changes nothing)'
    const keep = retentionDays > 0 ? `kept ${retentionDays} days` : 'kept forever'
    return { text: `gearbox ${state}. Policy: ${$.plugin.root}/config.json. Laya: ${ollamaPath} run ${layaModel}. Logs: ${await sessionLogDir($)} (${keep}).` }
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
            status: 'running',
            startedAt: now,
            tokens: 0,
            ...(e.cwd ? { cwd: e.cwd } : {}),
          }),
        )
      }
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
      ...(assessed.error ? { error: assessed.error } : {}),
      ms: assessed.ms,
    })
    return started
  }).catch((_, e, next) => (next.called ? undefined : next(e))) // the spawn goes on whatever happens here

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id && awaitingStep.delete(id)) {
      await record($, id, { kind: 'step', model: e.model, effort: e.effort ?? null })
    }
    const result = yield* next(e)
    if (id) {
      const effort = e.effort === undefined ? '' : String(e.effort)
      const u = result.usage
      const used = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      if ((await read($, agents)).some(r => r.id === id)) {
        await update($, agents, rows =>
          rows.map(r => (r.id === id ? { ...r, model: e.model, effort, status: 'running' as const, tokens: r.tokens + used } : r)),
        )
      }
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
      if (await isLogged($, id)) {
        const row = (await read($, agents)).find(r => r.id === id)
        await record($, id, { kind: 'end', reason: e.reason, durationMs: e.durationMs, tokens: row?.tokens ?? null })
      }
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
    const [rows, touched, pinned, cwd, now] = await Promise.all([read($, agents), read($, files), read($, selected), $.session.cwd(), $.clock.now()])
    const W = Math.max(24, e.props.bodyColumns)
    const running = rows.filter(r => r.status === 'running')
    // Running agents first, in the order they started; then the finished ones, newest first.
    const order = [...running, ...rows.filter(r => r.status !== 'running').reverse()]

    return (
      <Box flexDirection="column">
        <Text bold>
          {rows.length === 0 ? 'No subagents yet.' : `${running.length} running · ${rows.length - running.length} finished`}
        </Text>
        {order.map(row => {
          const glyph = GLYPH[row.status]
          const tier = Object.keys(TIER_COLOR).find(t => row.model.includes(t)) ?? ''
          const tree = fileTree(touched[row.id] ?? [], row.cwd ?? cwd)
          const isPinned = pinned === row.id
          const isActive = row.status === 'running'
          const took = row.durationMs ?? Math.max(0, now - row.startedAt)
          return (
            <Box key={`agent-${row.id}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row">
                <Box flexGrow={1}>
                  <Button key={`select-${row.id}`} plain onPress={() => void update($, selected, s => (s === row.id ? '' : row.id))}>
                    <Text color={glyph.color}>{glyph.text}</Text> <Text bold={isActive} dimColor={!isActive}>{cut(row.description || row.type, W - 8)}</Text>
                  </Button>
                </Box>
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
              </Box>
              <Text dimColor={!isActive}>
                {'  '}
                <Text color={TIER_COLOR[tier] ?? 'text'}>{row.model ? shortModel(row.model) : '…'}</Text>
                {` · ${row.effort || '…'}`}
                <Text dimColor>{` · ${cut(row.type, Math.max(8, W - 30))}`}</Text>
              </Text>
              <Text dimColor>{`  ${shortCount(row.tokens)} tokens · ${shortDuration(took)}`}</Text>
              {row.recommended && (
                <Text>
                  {'  '}
                  <Text color={matches(row) ? 'subtle' : 'warning'}>{`gearbox ${mode === 'apply' ? '✓' : '→'} ${row.recommended}`}</Text>
                </Text>
              )}
              {/* A selected agent's files stay open; any other's open while the pointer is on it. */}
              <Box flexDirection="column" {...(isPinned ? {} : { display: 'none' as const, hover: { display: 'flex' as const } })}>
                {tree.length === 0 && <Text dimColor>{'  no files yet'}</Text>}
                {tree.slice(0, MAX_TREE_LINES).map(line => (
                  <Text>
                    <Text dimColor>{`  ${line.prefix}`}</Text>
                    {line.isDir ? (
                      <Text color="suggestion">{line.name}</Text>
                    ) : (
                      <Text>
                        {line.op && <Text color={BADGE[line.op].color}>{`${BADGE[line.op].text} `}</Text>}
                        {cut(line.name, Math.max(8, W - line.prefix.length - 6))}
                        {(line.count ?? 0) > 1 && <Text dimColor>{` ×${line.count}`}</Text>}
                      </Text>
                    )}
                  </Text>
                ))}
                {tree.length > MAX_TREE_LINES && <Text dimColor>{`  … ${tree.length - MAX_TREE_LINES} more`}</Text>}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
