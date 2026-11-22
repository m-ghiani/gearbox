// What the agents pane draws from: one row per subagent and the files each one touched.
// This file holds no I/O, so the rows and the tree can be tested on their own.

import type { AgentRow, FileOp, FileTouch, Usage } from '../types'

// The pane keeps this many agents; the oldest finished ones leave first.
export const MAX_AGENTS = 30
// And this many files per agent.
export const MAX_FILES = 200

// The tools whose input names one file, and what each does to it.
export const FILE_TOOLS: Record<string, { op: FileOp; key: string }> = {
  Read: { op: 'read', key: 'file_path' },
  Edit: { op: 'edit', key: 'file_path' },
  MultiEdit: { op: 'edit', key: 'file_path' },
  Write: { op: 'write', key: 'file_path' },
  NotebookEdit: { op: 'edit', key: 'notebook_path' },
}

export function fileOf(tool: string, input: Record<string, unknown>): { path: string; op: FileOp } | null {
  const t = FILE_TOOLS[tool]
  const path = t ? input[t.key] : undefined
  return t && typeof path === 'string' && path !== '' ? { path, op: t.op } : null
}

export function addAgent(rows: readonly AgentRow[], row: AgentRow): AgentRow[] {
  const rest = rows.filter(r => r.id !== row.id)
  const all = [...rest, row]
  while (all.length > MAX_AGENTS) {
    const i = all.findIndex(r => r.status !== 'running')
    all.splice(i < 0 ? 0 : i, 1)
  }
  return all
}

export function patchAgent(rows: readonly AgentRow[], id: string, patch: Partial<AgentRow>): AgentRow[] {
  return rows.map(r => (r.id === id ? { ...r, ...patch } : r))
}

// An edit outranks a write, a write a shell change, a shell change a read: a file shows the
// most it had done to it.
const WEIGHT: Record<FileOp, number> = { read: 0, shell: 1, write: 2, edit: 3 }

export function noteFile(list: readonly FileTouch[], path: string, op: FileOp): FileTouch[] {
  const known = list.find(f => f.path === path)
  if (!known) {
    return [...list, { path, op, count: 1 }].slice(-MAX_FILES)
  }
  return list.map(f => (f.path === path ? { path, op: WEIGHT[op] > WEIGHT[f.op] ? op : f.op, count: f.count + 1 } : f))
}

// "claude-opus-5-5" → "opus 5.5"; anything else as it came.
export function shortModel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : model
}

export type TreeLine = { prefix: string; name: string; isDir: boolean; op?: FileOp; count?: number }

type Node = { dirs: Map<string, Node>; files: Map<string, FileTouch> }

function emptyNode(): Node {
  return { dirs: new Map(), files: new Map() }
}

// Paths under the session's directory are shown relative to it; others keep their full path.
function partsOf(path: string, cwd: string): string[] {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  const rel = cwd !== '' && path.startsWith(root) ? path.slice(root.length) : path
  return rel.split('/').filter(p => p !== '')
}

// A filetree-style tree: directories first, then files, both by name; a directory with a
// single subdirectory and no files is folded into it ("src/hooks").
export function fileTree(files: readonly FileTouch[], cwd: string): TreeLine[] {
  const root = emptyNode()
  for (const f of files) {
    const parts = partsOf(f.path, cwd)
    const name = parts.pop()
    if (name === undefined) {
      continue
    }
    let node = root
    for (const p of parts) {
      let child = node.dirs.get(p)
      if (!child) {
        child = emptyNode()
        node.dirs.set(p, child)
      }
      node = child
    }
    node.files.set(name, f)
  }

  const lines: TreeLine[] = []
  const walk = (node: Node, indent: string) => {
    const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
    const files = [...node.files.entries()].sort(([a], [b]) => a.localeCompare(b))
    const total = dirs.length + files.length
    let i = 0
    for (const [name, child] of dirs) {
      let label = name
      let inner = child
      while (inner.files.size === 0 && inner.dirs.size === 1) {
        const only = [...inner.dirs.entries()][0]
        if (!only) {
          break
        }
        label = `${label}/${only[0]}`
        inner = only[1]
      }
      const isLast = ++i === total
      lines.push({ prefix: `${indent}${isLast ? '└─ ' : '├─ '}`, name: `${label}/`, isDir: true })
      walk(inner, `${indent}${isLast ? '   ' : '│  '}`)
    }
    for (const [name, f] of files) {
      const isLast = ++i === total
      lines.push({ prefix: `${indent}${isLast ? '└─ ' : '├─ '}`, name, isDir: false, op: f.op, count: f.count })
    }
  }
  walk(root, '')
  return lines
}

export function cut(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

// "1234" → "1.2k", "1234567" → "1.2M".
export function shortCount(n: number): string {
  if (n < 1000) {
    return String(n)
  }
  return n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`
}

// "83000" → "1m 23s".
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// `git status --porcelain=v1 -z`: each entry "XY path", a rename or copy followed by the path
// it came from. Paths are relative to the repository's root.
export function parseGitStatus(out: string): Map<string, string> {
  const status = new Map<string, string>()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) {
      continue
    }
    const xy = entry.slice(0, 2)
    status.set(entry.slice(3), xy)
    if (xy.includes('R') || xy.includes('C')) {
      i++ // the source path, which the change does not touch any more
    }
  }
  return status
}

// The paths whose status a command changed: new to the list, or listed differently. A file
// that was already modified and is modified again shows no change: git cannot tell.
export function gitChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...after.entries()].filter(([path, xy]) => before.get(path) !== xy).map(([path]) => path)
}

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

// "1.234" → "$1.23"; under a dollar two significant digits: "0.0042" → "$0.0042".
export function shortDollars(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2).replace(/0+$/, '').replace(/\.$/, '')}`
}

// The status line's entry: what runs and what finished; undefined clears it.
export function statusText(rows: readonly AgentRow[]): string | undefined {
  if (rows.length === 0) {
    return undefined
  }
  const running = rows.filter(r => r.status === 'running').length
  return `⚙ ${running} running · ${rows.length - running} finished`
}

// The finished agents that ended more than `minutes` ago; none when minutes is 0.
export function expiredAgents(rows: readonly AgentRow[], now: number, minutes: number): string[] {
  if (minutes <= 0) {
    return []
  }
  const cutoff = now - minutes * 60_000
  return rows.filter(r => r.status !== 'running' && r.startedAt + (r.durationMs ?? 0) <= cutoff).map(r => r.id)
}
