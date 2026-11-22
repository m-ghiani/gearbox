export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AgentStatus = 'running' | 'done' | 'stopped' | 'failed'

// Tokens by kind, summed over an agent's steps.
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

// One subagent in the agents pane.
export type AgentRow = {
  id: string
  description: string
  type: string
  // As the engine resolved it, e.g. "claude-opus-5-5"; '' until known.
  model: string
  // A level, or a thinking budget written as a number; '' until the first step.
  effort: string
  // What gearbox would have picked, when it assessed the spawn.
  recommended?: string
  status: AgentStatus
  startedAt: number
  // Input and output tokens of all its steps so far, cache reads and writes included.
  tokens: number
  // The same tokens by kind, and what they cost by config.json's prices; no cost without one.
  usage?: Usage
  cost?: number
  // Applying, whether gearbox chose its model, and so sets its effort at each step.
  applied?: boolean
  // Set when it finishes: how long its run took.
  durationMs?: number
  // Where it runs, when it runs elsewhere than the session (a worktree).
  cwd?: string
}

// `shell`: a Bash command changed the file's git status.
export type FileOp = 'read' | 'edit' | 'write' | 'shell'

export type FileTouch = { path: string; op: FileOp; count: number }

declare module 'claude-code' {
  interface PluginState {
    gearbox: {
      // Turned off for this session with /gearbox off.
      disabled: boolean
      // The agents pane: one row per subagent, oldest first.
      agents: Shaped<AgentRow[]>
      // The files each subagent touched, by agent id.
      files: Shaped<Record<string, FileTouch[]>>
      // The agent whose files stay open in the pane; '' for none.
      selected: string
      // The effort above high the person's latest prompt asked for; '' for none.
      askedEffort: Effort | ''
      // The effort above high /gearbox effort set for the session; '' for none.
      effortOverride: Effort | ''
      // Bumped each second while an agent runs, so the pane redraws its times.
      tick: number
    }
  }
}
