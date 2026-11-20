import type { Effort } from '../types'

// What gearbox decides with, read from config.json: the questions put to Laya, the table that
// turns its answers into a model and an effort, and the floors that raise the result. This
// file holds no I/O, so the whole decision can be tested and checked on its own.

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type Gear = { model: string; effort: Effort }

export type Floor = {
  name: string
  // Signals from the brief that trigger the floor.
  when: string[]
  // Laya's "costly mistake" probability that triggers it too.
  layaRisk?: number
  // Kinds of work the floor does not apply to.
  exceptWork: string[]
  atLeast: Gear
}

export type Config = {
  // Weakest to strongest: a floor compares gears by this order, then by effort.
  models: string[]
  laya: { briefChars: number; timeoutMs: number }
  // Options ordered from the least to the most demanding: on a near tie the later one wins.
  work: { ask: string; options: { id: string; description: string }[] }
  difficulty: { ask: string; levels: string[] }
  risk: { ask: string }
  table: Record<string, Gear[]>
  tieMargin: number
  // What the rules assume when Laya does not answer.
  fallback: { work: string; difficulty: number }
  signals: Record<string, RegExp>
  floors: Floor[]
}

type Parsed = { config: Config; error?: undefined } | { config?: undefined; error: string }

class ConfigError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConfigError(`${path}: a non-empty string is expected`)
  }
  return v
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ConfigError(`${path}: a number from ${min} to ${max} is expected`)
  }
  return v
}

function list(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ConfigError(`${path}: a non-empty list is expected`)
  }
  return v
}

function record(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) {
    throw new ConfigError(`${path}: an object is expected`)
  }
  return v
}

// A gear is written "model:effort", e.g. "opus:high".
function gear(v: unknown, path: string, models: string[]): Gear {
  const [model = '', effort = ''] = text(v, path).split(':')
  if (!models.includes(model)) {
    throw new ConfigError(`${path}: "${model}" is not one of models (${models.join(', ')})`)
  }
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new ConfigError(`${path}: "${effort}" is not an effort (${EFFORTS.join(', ')})`)
  }
  return { model, effort: effort as Effort }
}

function names(v: unknown, path: string, allowed: string[]): string[] {
  return (v === undefined ? [] : list(v, path)).map((x, i) => {
    const name = text(x, `${path}[${i}]`)
    if (!allowed.includes(name)) {
      throw new ConfigError(`${path}[${i}]: "${name}" is not one of ${allowed.join(', ')}`)
    }
    return name
  })
}

// The whole file or nothing: a half-read policy would decide in ways nobody wrote down.
export function parseConfig(raw: unknown): Parsed {
  try {
    const c = record(raw, 'config')
    const models = list(c.models, 'models').map((m, i) => text(m, `models[${i}]`))

    const laya = record(c.laya, 'laya')
    const work = record(c.work, 'work')
    const options = list(work.options, 'work.options').map((o, i) => {
      const r = record(o, `work.options[${i}]`)
      return { id: text(r.id, `work.options[${i}].id`), description: text(r.description, `work.options[${i}].description`) }
    })
    const ids = options.map(o => o.id)
    const difficulty = record(c.difficulty, 'difficulty')
    const levels = list(difficulty.levels, 'difficulty.levels').map((l, i) => text(l, `difficulty.levels[${i}]`))

    const tableRaw = record(c.table, 'table')
    const table: Record<string, Gear[]> = {}
    for (const id of ids) {
      const row = list(tableRaw[id], `table.${id}`)
      if (row.length !== levels.length) {
        throw new ConfigError(`table.${id}: ${levels.length} gears expected, one per difficulty level`)
      }
      table[id] = row.map((x, i) => gear(x, `table.${id}[${i}]`, models))
    }

    const signals: Record<string, RegExp> = {}
    for (const [name, s] of Object.entries(record(c.signals, 'signals'))) {
      const r = record(s, `signals.${name}`)
      try {
        signals[name] = new RegExp(text(r.pattern, `signals.${name}.pattern`), typeof r.flags === 'string' ? r.flags : '')
      } catch (err) {
        if (err instanceof ConfigError) {
          throw err
        }
        throw new ConfigError(`signals.${name}: not a valid regular expression (${String(err)})`)
      }
    }

    const floors = list(c.floors, 'floors').map((f, i) => {
      const r = record(f, `floors[${i}]`)
      return {
        name: text(r.name, `floors[${i}].name`),
        when: names(r.when, `floors[${i}].when`, Object.keys(signals)),
        ...(r.layaRisk === undefined ? {} : { layaRisk: num(r.layaRisk, `floors[${i}].layaRisk`, 0, 1) }),
        exceptWork: names(r.exceptWork, `floors[${i}].exceptWork`, ids),
        atLeast: gear(r.atLeast, `floors[${i}].atLeast`, models),
      }
    })

    const fallback = record(c.fallback, 'fallback')
    const fallbackWork = text(fallback.work, 'fallback.work')
    if (!ids.includes(fallbackWork)) {
      throw new ConfigError(`fallback.work: "${fallbackWork}" is not one of ${ids.join(', ')}`)
    }

    return {
      config: {
        models,
        laya: {
          briefChars: num(laya.briefChars, 'laya.briefChars', 100, 100_000),
          timeoutMs: num(laya.timeoutMs, 'laya.timeoutMs', 500, 60_000),
        },
        work: { ask: text(work.ask, 'work.ask'), options },
        difficulty: { ask: text(difficulty.ask, 'difficulty.ask'), levels },
        risk: { ask: text(record(c.risk, 'risk').ask, 'risk.ask') },
        table,
        tieMargin: num(c.tieMargin, 'tieMargin', 0, 1),
        fallback: { work: fallbackWork, difficulty: num(fallback.difficulty, 'fallback.difficulty', 0, levels.length - 1) },
        signals,
        floors,
      },
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      return { error: err.message }
    }
    throw err
  }
}

export function signalsOf(config: Config, brief: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(config.signals).map(([name, re]) => [name, re.test(brief)]))
}

export type LayaAnswers = {
  work: Record<string, number>
  difficulty: number[]
  risk: number
}

function prob(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// Ollama prints `{"answers": {"q1": ..., "q2": ..., "q3": ...}}`, the questions in the order
// they were asked. Anything else is refused rather than guessed at.
export function parseLaya(config: Config, stdout: string): LayaAnswers | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end < start) {
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return null
  }
  const answers = isRecord(json) && isRecord(json.answers) ? json.answers : null
  const q1 = answers && isRecord(answers.q1) && isRecord(answers.q1.probabilities) ? answers.q1.probabilities : null
  const q2 = answers && isRecord(answers.q2) && isRecord(answers.q2.probabilities) ? answers.q2.probabilities : null
  const q3 = answers && isRecord(answers.q3) ? answers.q3.noul : undefined
  if (!q1 || !q2 || typeof q3 !== 'number') {
    return null
  }
  return {
    work: Object.fromEntries(config.work.options.map(o => [o.id, prob(q1[o.id])])),
    difficulty: config.difficulty.levels.map((_, i) => prob(q2[String(i)])),
    risk: q3,
  }
}

// The most demanding option whose probability is within the margin of the top one.
export function upOnTie(probabilities: readonly number[], margin: number): number {
  const top = Math.max(...probabilities)
  let pick = 0
  probabilities.forEach((p, i) => {
    if (p >= top - margin) {
      pick = i
    }
  })
  return pick
}

function rank(config: Config, x: Gear): number {
  return config.models.indexOf(x.model) * EFFORTS.length + EFFORTS.indexOf(x.effort)
}

export function gearName(x: Gear): string {
  return `${x.model}:${x.effort}`
}

export type Pick = { gear: Gear; work: string; level: number; why: string[] }

// Laya says what the work is; the table and the floors say what it runs on.
export function choose(config: Config, answers: LayaAnswers | null, signals: Record<string, boolean>): Pick {
  const ids = config.work.options.map(o => o.id)
  const work = answers ? (ids[upOnTie(ids.map(id => answers.work[id] ?? 0), config.tieMargin)] ?? config.fallback.work) : config.fallback.work
  const level = answers ? upOnTie(answers.difficulty, config.tieMargin) : config.fallback.difficulty
  const row = config.table[work] ?? []
  // parseConfig gives every row one gear per level, and level indexes those levels.
  let gear = row[level] ?? row[row.length - 1] ?? { model: config.models[0] ?? '', effort: 'medium' }
  const why = [`${work}, ${config.difficulty.levels[level] ?? level}${answers ? '' : ' (rules only)'}`]

  for (const floor of config.floors) {
    const bySignal = floor.when.some(s => signals[s])
    const byLaya = floor.layaRisk !== undefined && answers !== null && answers.risk >= floor.layaRisk
    if ((bySignal || byLaya) && !floor.exceptWork.includes(work) && rank(config, gear) < rank(config, floor.atLeast)) {
      gear = floor.atLeast
      why.push(`${floor.name}: at least ${gearName(floor.atLeast)}`)
    }
  }
  return { gear, work, level, why }
}

// The brief goes on stdin, never into argv: it is written by a model and is untrusted.
export function layaArgv(config: Config, ollama: string, model: string): string[] {
  const argv = [ollama, 'run', model, '--format', 'json', '--ask', config.work.ask]
  for (const o of config.work.options) {
    argv.push('--choice', `${o.id}=${o.description}`)
  }
  argv.push('--ask', config.difficulty.ask)
  for (const level of config.difficulty.levels) {
    argv.push('--level', level)
  }
  argv.push('--ask', config.risk.ask)
  return argv
}

export function layaState(config: Config, subagentType: string, description: string, prompt: string): string {
  return `Subagent: ${subagentType}\nTask: ${description}\n\n${prompt.slice(0, config.laya.briefChars)}`
}
