// Which logs are old enough to remove. This file holds no I/O, so the choice can be tested.

// Session ids and 0.1's single files: nothing else under the log folder is ever removed.
const LOG_NAME = /^[A-Za-z0-9-]+(\.jsonl)?$/

export type LogEntry = { name: string; mtimeMs: number; isLink: boolean }

// The entries of the log folder last written before `retentionDays`, the current session's
// excepted; none when retentionDays is 0. An entry with no time (0) is kept.
export function staleLogs(entries: readonly LogEntry[], now: number, retentionDays: number, currentSession: string): string[] {
  if (retentionDays <= 0) {
    return []
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  return entries
    .filter(e => LOG_NAME.test(e.name) && !e.isLink && e.name.replace(/\.jsonl$/, '') !== currentSession)
    .filter(e => e.mtimeMs > 0 && e.mtimeMs < cutoff)
    .map(e => e.name)
}
