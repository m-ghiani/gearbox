// /gearbox report: what the logs say about gearbox's picks against what the subagents ran on
// and how they ended. This file holds no I/O, so the summary can be tested on its own.

import { shortCount } from './agents'
import { EFFORTS } from './policy'

type Joined = {
  recommended: string
  ranOn: string
  effort: string
  work: string
  hasLaya: boolean
  reason?: string
  tokens?: number
}

type Direction = 'same' | 'higher' | 'lower' | 'unknown'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// One agent's spawn, step and end lines, joined by agentId. A spawn with no agent (refused)
// and a step or end with no assessed spawn are left out.
export function join(lines: readonly unknown[]): Joined[] {
  const byAgent = new Map<string, Partial<Joined> & { hasSpawn?: boolean }>()
  const at = (id: string) => {
    const known = byAgent.get(id) ?? {}
    byAgent.set(id, known)
    return known
  }
  for (const line of lines) {
    if (!isRecord(line) || typeof line.agentId !== 'string') {
      continue
    }
    const one = at(line.agentId)
    if (line.kind === 'spawn') {
      const why = Array.isArray(line.why) ? str(line.why[0]) : ''
      Object.assign(one, {
        hasSpawn: true,
        recommended: str(line.recommended),
        ranOn: str(line.ranOn),
        work: why.split(',')[0]?.trim() || 'unknown',
        hasLaya: isRecord(line.laya),
      })
    } else if (line.kind === 'step') {
      one.effort = line.effort === null || line.effort === undefined ? '' : String(line.effort)
    } else if (line.kind === 'end') {
      one.reason = str(line.reason)
      if (typeof line.tokens === 'number') {
        one.tokens = line.tokens
      }
    }
  }
  return [...byAgent.values()]
    .filter(j => j.hasSpawn && j.recommended)
    .map(j => ({
      recommended: j.recommended ?? '',
      ranOn: j.ranOn ?? '',
      effort: j.effort ?? '',
      work: j.work ?? 'unknown',
      hasLaya: j.hasLaya ?? false,
      ...(j.reason !== undefined ? { reason: j.reason } : {}),
      ...(j.tokens !== undefined ? { tokens: j.tokens } : {}),
    }))
}

// Whether gearbox's model is above, below or the same as the one that ran, by the order of
// `models` (weakest first); a model id names its family ("claude-opus-5-5" is opus).
export function modelDirection(models: readonly string[], recommended: string, ranOn: string): Direction {
  const want = models.indexOf(recommended.split(':')[0] ?? '')
  const ran = models.findIndex(m => ranOn.includes(m))
  if (want < 0 || ran < 0) {
    return 'unknown'
  }
  return want === ran ? 'same' : want > ran ? 'higher' : 'lower'
}

export function effortDirection(recommended: string, effort: string): Direction {
  const levels: readonly string[] = EFFORTS
  const want = levels.indexOf(recommended.split(':')[1] ?? '')
  const ran = levels.indexOf(effort)
  if (want < 0 || ran < 0) {
    return 'unknown'
  }
  return want === ran ? 'same' : want > ran ? 'higher' : 'lower'
}

function pct(n: number, of: number): string {
  return of === 0 ? '–' : `${Math.round((100 * n) / of)}%`
}

function count<T>(items: readonly T[], key: (x: T) => string): Map<string, number> {
  const out = new Map<string, number>()
  for (const x of items) {
    out.set(key(x), (out.get(key(x)) ?? 0) + 1)
  }
  return out
}

export function summarize(lines: readonly unknown[], models: readonly string[], scope: string): string {
  const all = join(lines)
  if (all.length === 0) {
    return `gearbox report (${scope}): no assessed subagents in the logs yet.`
  }
  const withModel = all.map(j => ({ ...j, model: modelDirection(models, j.recommended, j.ranOn), effortDir: effortDirection(j.recommended, j.effort) }))
  const known = withModel.filter(j => j.model !== 'unknown')
  const models_ = count(known, j => j.model)
  const efforts = withModel.filter(j => j.effortDir !== 'unknown')
  const efforts_ = count(efforts, j => j.effortDir)
  const ended = withModel.filter(j => j.reason !== undefined)

  const out: string[] = [`gearbox report (${scope}): ${all.length} assessed subagents, Laya answered for ${pct(all.filter(j => j.hasLaya).length, all.length)}.`, '']

  out.push(`Model: gearbox agrees on ${pct(models_.get('same') ?? 0, known.length)} of ${known.length}; it would go higher for ${models_.get('higher') ?? 0}, lower for ${models_.get('lower') ?? 0}.`)
  out.push(`Effort: gearbox agrees on ${pct(efforts_.get('same') ?? 0, efforts.length)} of ${efforts.length}; it would go higher for ${efforts_.get('higher') ?? 0}, lower for ${efforts_.get('lower') ?? 0}.`)
  out.push('')

  out.push('How they ended, by what gearbox would have done with the model:')
  for (const dir of ['same', 'higher', 'lower'] as const) {
    const group = ended.filter(j => j.model === dir)
    if (group.length === 0) {
      continue
    }
    const done = group.filter(j => j.reason === 'answer').length
    const used = group.reduce((n, j) => n + (j.tokens ?? 0), 0)
    out.push(`  ${dir.padEnd(6)} ${String(group.length).padStart(4)} agents, ${pct(done, group.length).padStart(4)} answered, ${shortCount(used)} tokens`)
  }
  const cheaper = ended.filter(j => j.model === 'lower' && j.reason === 'answer')
  if (cheaper.length > 0) {
    out.push(`  Room to save: ${cheaper.length} agents answered on a model above gearbox's pick, using ${shortCount(cheaper.reduce((n, j) => n + (j.tokens ?? 0), 0))} tokens.`)
  }
  const failedLow = ended.filter(j => j.model === 'higher' && j.reason !== 'answer')
  if (failedLow.length > 0) {
    out.push(`  Too low?: ${failedLow.length} agents did not answer on a model below gearbox's pick.`)
  }
  out.push('')

  out.push('By kind of work:')
  for (const [work, n] of [...count(withModel, j => j.work).entries()].sort((a, b) => b[1] - a[1])) {
    const group = withModel.filter(j => j.work === work && j.model !== 'unknown')
    out.push(`  ${work.padEnd(14)} ${String(n).padStart(4)} agents, model agrees ${pct(group.filter(j => j.model === 'same').length, group.length)}`)
  }
  return out.join('\n')
}
