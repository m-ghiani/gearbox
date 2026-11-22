# gearbox

A Claude Code mod that picks the model and effort for each subagent with [Laya](https://github.com/NandhaKishorM/laya), a local decision model running in Ollama, and shows every subagent in a pane: the model and effort it runs on, what gearbox would have picked, its tokens and time, and the files it works on. Only subagents are touched: the main session's model never changes, so its prompt cache is never broken.

For each subagent it asks Laya what the work is, turns the answers into a model and an effort, and logs that next to what the subagent actually ran on and how it ended. It has two modes:

- **observe** (the default) changes nothing. The subagent starts at once and Laya is asked while it runs. The logs are the evaluation set that `/gearbox report` reads, to tune `config.json` before applying anything.
- **apply** starts each subagent on the model gearbox picked, unless the caller named one, and runs each of its steps at the effort gearbox picked, from the first step on, so the subagent's cache is never broken by a change. A subagent whose model the caller named keeps the effort it would have had, and so does a model without effort levels. The subagent waits for Laya (up to `laya.timeoutMs`) before it starts, unless Laya has answered the same brief before in the session.

## Requirements

- **Claude Code** with mod (hooks module) support.
- **Ollama** with decision-model support: `ollama run --help` lists `--ask`, `--choice` and `--level`.
- **The Laya model** in Ollama, installed as described in the [Laya repository](https://github.com/NandhaKishorM/laya): `ollama list` shows `laya`.

Check that Laya answers before installing the mod:

```bash
echo "Find where the config file is loaded in src/." \
  | ollama run laya --format json --ask "What kind of work is this?" \
      --choice search="Read files" --choice implement="Write code"
```

The output ends with a JSON object holding `"answers"`. If it does not, fix Ollama or Laya first: without them the mod still runs, but only on its rules (see [How it decides](#how-it-decides)).

## Install

This folder is also a marketplace (`.claude-plugin/marketplace.json`) that lists gearbox.

From a local copy:

```bash
claude plugin marketplace add /path/to/gearbox
claude plugin install gearbox@gearbox
```

From GitHub, once the folder is pushed to a repository (Claude Code 2.1.275 or later):

```
/plugin install gearbox --marketplace <owner>/<repo>
```

After editing a local copy, `claude plugin marketplace update gearbox` picks up the changes.

To try it for one session without installing it:

```bash
claude --plugin-dir /path/to/gearbox
```

Then check it is running:

1. Type `/gearbox`. It answers `gearbox on, observing (it changes nothing)`, with the policy file, the Laya command and the log folder.
2. Let Claude launch any subagent (e.g. ask for a search across the codebase).
3. Open the agent's file in the log folder named by `/gearbox`: a `spawn` line with `"laya": {...}` means Laya answered; `"laya": null` with an `error` means the rules decided alone, and the error says why.

## Configure

### Options

In `/config`, under the mod's name:

| Option | Default | |
| --- | --- | --- |
| Ollama executable | `ollama` | the full path if the app does not see your shell's `PATH`, e.g. `/opt/homebrew/bin/ollama` (`which ollama` prints it) |
| Laya model | `laya` | the model's name in Ollama, as `ollama list` shows it |
| Mode | `observe` | `observe` changes nothing; `apply` starts subagents on the model gearbox picks (see above) |
| Keep logs (days) | `30` | logs of other sessions older than this are removed when a session starts; `0` keeps them all |
| Notify when an agent ends | `on` | a notice says when a subagent finishes, how it ended and how long it ran; `off` leaves it to the pane |
| Clear finished agents after (minutes) | `0` | a finished subagent leaves the pane this many minutes after it ends; `0` keeps it until `clear` or `/clear` |

From the command line: `claude plugin configure gearbox@gearbox`, or `echo '{"mode":"apply"}' | claude plugin configure gearbox@gearbox --values-stdin`. A change applies from the next session.

### The policy: config.json

The questions, the table and the floors are in `config.json`, beside this README. It is read when the mod loads: after editing it, reload the mod (`/reload-plugins`, or a new session).

| Field | What it holds |
| --- | --- |
| `models` | the model aliases, weakest to strongest. Floors compare by this order, then by effort |
| `laya.briefChars` | how much of the brief Laya reads (100–100000; the Ollama checkpoint reads 512 tokens, questions included) |
| `laya.timeoutMs` | how long to wait for Laya before the rules alone decide (500–60000) |
| `work` | the first question and its options, **least to most demanding**: on a near tie the later one wins |
| `difficulty` | the second question and its levels, lowest first |
| `risk` | the third question, answered yes or no |
| `table` | for each `work` option, one `"model:effort"` per difficulty level |
| `tieMargin` | options within this probability of the top one count as a tie (0–1) |
| `fallback` | the work and difficulty level assumed when Laya does not answer |
| `signals` | regular expressions run on the whole brief (`pattern`, optional `flags`) |
| `floors` | minimum gears: `when` lists signals that trigger it, `layaRisk` the probability of "costly" that triggers it too, `exceptWork` the kinds of work it skips, `atLeast` the gear |
| `prices` | optional: dollars per million tokens for each model of `models` (`input`, `output`, `cacheRead`, `cacheWrite`), for the pane's and the report's cost estimates. A model without a price has no estimate |

Efforts are `low`, `medium`, `high`, `xhigh`, `max`. gearbox picks at most `high` on its own: a gear of `table` or `floors` above it is lowered to `high`. `xhigh` and `max` are yours to ask for: when your latest prompt says `xhigh` (or `x-high`, `extra high`), or `max effort` (or `sforzo massimo`), every subagent it starts is picked at that effort, on the model the table and floors give. The next prompt that does not ask goes back to `high` at most. A prompt that merely mentions `xhigh` counts as asking: where that matters, `/gearbox effort xhigh` (or `max`) sets the effort for every subagent of the session, whatever the prompts say, until `/gearbox effort auto`.

The shipped `prices` are Anthropic's API list prices for Haiku 5.5, Sonnet 5.5 and Opus 5.5 as of October 2026; `cacheWrite` is taken as 1.25× `input` (the 5-minute cache) and Haiku's `cacheRead` as 0.1× `input`. They are estimates: a subscription, a cloud provider's prices or another model version cost differently, so set your own where they differ.

Some examples:

- **Cheaper reviews**: change `table.review` to `["haiku:medium", "sonnet:medium", "sonnet:high", "opus:medium"]`.
- **A new signal**: add `"payments": { "pattern": "\\b(stripe|invoice|refund)\\b", "flags": "i" }` to `signals`, then add `"payments"` to the `when` list of the `costly mistake` floor.
- **A new kind of work**: add an option to `work.options` in its place by demand, and a row with the same `id` to `table`.

The file is checked whole when it is read. If anything is wrong (a model not in `models`, a row without one gear per level, a regular expression that does not compile), gearbox turns itself off for the session, says so in a notice, and `/gearbox` names the field. Subagents start untouched.

### A project's own policy: .claude/gearbox.json

A project can tune the policy for itself in `.claude/gearbox.json`, in the directory the session starts in. It holds any fields of `config.json`: `table`, `signals` and `prices` are merged entry by entry over the shipped ones, any other field replaces the shipped one. For a Rust workspace, for example:

```json
{
  "table": { "review": ["sonnet:medium", "sonnet:high", "opus:medium", "opus:high"] },
  "signals": { "ffi": { "pattern": "\\b(ffi|extern \"C\")\\b" } },
  "floors": [{ "name": "ffi", "when": ["ffi"], "atLeast": "opus:medium" }]
}
```

The result is checked whole, like `config.json` alone: if it is wrong, gearbox is off for the session and `/gearbox` names the field and the file. When a project policy is in use, a notice says so at the start of the session and `/gearbox` names it: a repository you clone can change what your subagents run on, and its regular expressions run on every brief.

## Use

| | |
| --- | --- |
| `/gearbox` | state and mode, the policy file, the Laya command and where this session's logs are; if config.json is invalid, why |
| `/gearbox off` / `on` | stops or resumes assessing in this session |
| `/gearbox effort xhigh` / `max` / `auto` | sets an effort above `high` for every subagent of the session, or lets gearbox pick again (at most `high`, unless a prompt asks) |
| `/gearbox agents` | opens the agents pane |
| `/gearbox report` | what the logs of all sessions say (`/gearbox report session`: this session only) |

Forks, resumed agents and workflow agents are not assessed.

At the start of a session gearbox asks Laya once with a brief of no consequence, so the model is loaded in Ollama before the first real subagent; it also removes logs older than **Keep logs**. Neither holds the session up. Laya's answers are kept for the session (the last 100 briefs): a subagent with the same type, description and brief as an earlier one is not asked again, and its spawn line says `"cached": true`.

While subagents exist, the status line shows `⚙ 1 running · 2 finished`.

### The report

`/gearbox report` joins each assessed subagent's spawn, step and end lines and says:

- **Model** and **Effort**: how often gearbox's pick agrees with what ran, and how often it would have gone higher or lower.
- **How they ended**, grouped by what gearbox would have done with the model: how many answered (rather than being stopped or failing) and the tokens they used.
- **Room to save**: agents that answered on a model above gearbox's pick, with their tokens and, where `prices` covers both models, what they cost against what the same tokens would cost on gearbox's picks; **Too low?**: agents that did not answer on a model below it.
- **Estimated spend**: what the ended agents cost at the `prices` of `config.json`, and on gearbox's picks. The same tokens are priced on both sides, so it is an estimate: another model would not have used exactly the same tokens. Logs written before 0.4 hold no usage and are left out of it.
- **By kind of work**: how many of each, and how often gearbox agrees on the model.

Read it before switching to `apply`: a high agreement with many answered agents says the table is right; many "Too low?" say a row of `table` or a floor should go up.

### The agents pane

The pane opens at the start of a session, docked beside the transcript in the fullscreen terminal when it is wide enough (otherwise `/gearbox agents`). It lists every subagent of the session in two groups: **RUNNING**, each agent framed, in the order they started; and **FINISHED**, folded to two lines, newest first. An agent moves from the first group to the second the moment it ends.

```
 RUNNING · 1
╭──────────────────────────────────────────╮
│ ● Fix the parser                       ↗ │
│   sonnet 5.5 · medium · rust-engineer    │
│   48.2k tokens · ≈ $0.21 · 1m 12s        │
│   ⚙ gearbox → opus:medium                │
│   ├─ src/                                │
│   │  └─ M parse.rs ×2                    │
│   └─ R Cargo.toml                        │
╰──────────────────────────────────────────╯

 FINISHED · 2                         clear
 ✓ Find the config loader      done · 14s ↗
   haiku 5.5 · low · 9.1k tokens · ≈ $0.001

 ✗ Run the test suite        failed · 41s ↗
   sonnet 5.5 · medium · 22.0k tokens · ≈ $0.07
```

- **The status**: `●` running; a finished agent says how it ended, in words and colour: `✓ done` (green), `■ stopped` (yellow), `✗ failed` (red), with how long it ran.
- **`clear`**: removes the finished agents, and their files, from the pane. The logs keep them.
- **`↗`**: opens the agent's transcript in the main view, as the tasks list does.
- **The second line**: the model and the effort the subagent really runs on, and its type.
- **The third line**: the tokens of all its requests (input, output and cache), what they cost by the `prices` of `config.json` (`≈ $0.42`, absent for a model without a price), and how long it has run, counted each second, or ran.
- **`⚙ gearbox →`** (in `apply` mode `⚙ gearbox ✓`): what gearbox picked, in bold yellow when it differs from what runs; on a finished agent it shows only when it differs. Absent for forks, resumes, workflow agents and while `/gearbox off`; observing, it appears a moment after the agent, once Laya has answered.
- **The files**: point at an agent to see them, or select it (a click, or ctrl+x tab to focus the pane, then Enter) to keep them open; select it again to close them. `M` edited, `W` written, `B` changed by a Bash command, `R` read, `×n` how many times. Paths under the agent's directory are shown relative to it.

Read, Edit, MultiEdit, Write and NotebookEdit name their file. A Bash command does not: gearbox runs `git status` in the agent's directory before and after it, and credits the command with the files whose status changed. So a file outside a git repository, an ignored file (`target/` in most Rust projects), or a file that was already modified and is modified again is not shown; and a file another agent changes while the command runs is credited to it too.

The pane keeps the last 30 agents and 200 files per agent; `/clear` empties it. It follows subagents even while `/gearbox off`.

## How it decides

Laya never picks a model. It answers questions about the work; `config.json` turns the answers into a model and an effort.

1. **Signals from the brief**, without a model: several crates, `unsafe`, concurrency, security, data and migrations.
2. **Laya**, three typed questions in one forward pass: the kind of work (search, review, implement, diagnose, architecture), the difficulty (trivial to very hard), and whether a mistake would be costly.
3. **A table** turns kind × difficulty into model · effort. Writing code never goes below Sonnet. A costly mistake raises the floor to Opus · medium, and work across several crates to Opus · high. When two answers are within 0.15 of each other the more demanding one wins, because Laya's shipped checkpoints are not calibrated.

If Ollama is missing or slow (10 s timeout), the rules alone decide from the fallback and the subagent starts as usual.

In `apply` mode a spawn takes the pick's model alias (`haiku`, `sonnet`, `opus`); a model named in the Agent call stands. To let gearbox decide, keep your instructions (CLAUDE.md) from asking Claude to name a model in the Agent call.

## The log

One folder per session, one file per assessed subagent: `~/.claude/mods/gearbox/<session id>/<agent id>.jsonl` (under `$CLAUDE_CONFIG_DIR` if set). Version 0.1 wrote one file per session, `~/.claude/mods/gearbox/<session id>.jsonl`; `/gearbox report` reads both.

- A `spawn` line holds the mode and whether the pick was applied, the subagent type, the **whole brief**, the model the session asked for and the one it ran on, the recommendation and why, the signals, Laya's probabilities and how long Laya took.
- A `step` line holds the effort the subagent really ran at.
- An `end` line holds how it ended (`answer`, `aborted`, `refusal`, `error`), how long it ran and the tokens it used.

`/gearbox report` reads them for you. For your own queries:

```bash
jq -c 'select(.kind == "spawn") | {description, ranOn, recommended, why, ms}' ~/.claude/mods/gearbox/*/*.jsonl
```

The briefs can contain anything you gave the subagents. Logs of other sessions older than **Keep logs** (30 days by default) are removed when a session starts; with `0` they are never removed.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Every `spawn` line has `"laya": null` and `error` mentions `not found` | the app does not find Ollama: set **Ollama executable** to the full path |
| `error` mentions the model | Laya is not in Ollama under that name: check `ollama list` and **Laya model** |
| `error` mentions a timeout | the first call loads the model; raise `laya.timeoutMs` if it keeps happening |
| A notice says `config.json is invalid` | `/gearbox` names the field; fix it and reload the mod |
| No log file | no subagent was assessed yet (forks, resumes and workflow agents never are), or `/gearbox off` is set |
| No `B` files in the pane | the agent's directory is not in a git repository, or the files are ignored by git |
| `↗` says it cannot open the agent | the tasks list no longer shows it: finished subagents leave it after a while |

## Development

```bash
claude plugin validate .
claude plugin test .
```

The same two checks run in CI on every push and pull request (`.github/workflows/ci.yml`).

| File | What it holds |
| --- | --- |
| `hooks/register.tsx` | the hooks: spawn, steps, tool calls, the command and the pane |
| `hooks/policy.ts` | config.json, the questions to Laya and the decision; no I/O |
| `hooks/agents.ts` | the pane's rows, the file tree and git status; no I/O |
| `hooks/report.ts` | `/gearbox report`'s summary; no I/O |
| `hooks/logs.ts` | which logs are stale; no I/O |
| `hooks/*.test.ts(x)`, `hooks/fixture.ts` | the tests and their config fixture |

## License

MIT
