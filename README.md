<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-messenger/main/banner.png" alt="omp-messenger" width="1100">
</p>

# omp-messenger

**What if multiple agents in different terminals — or on different machines — could talk to each other like they're in a chat room?** Join, see who's online and what they're doing. Claim tasks, reserve files, send messages, run a crew of workers.

A fork of [pi-messenger](https://github.com/nicobailon/pi-messenger) rebuilt for [oh-my-pi](https://github.com/can1357/oh-my-pi): a **mesh** transport seam with named **channels** so sessions on different machines coordinate through one mesh server (Docker), crew workers that run as in-process omp subagents, non-interrupting `aside` message delivery, and a `crew.team.enabled` switch. The local filesystem mesh remains the zero-config default — no daemon, no server, just files.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

## Installation

```bash
omp plugin install github:harshav167/omp-messenger
```

Or link a local checkout while developing:

```bash
omp plugin link .
```

Crew agents ship with the plugin (`agents/*.md`) and are discovered automatically — by crew and by omp's own `task` tool. The `omp-messenger-crew` skill is auto-loaded from the plugin. Workers can load domain-specific [crew skills](#crew-skills) on demand during task execution.

### Multi-machine mesh

Run the mesh server once on any host (Docker):

```bash
echo "OMP_MESSENGER_MESH_TOKEN=$(openssl rand -hex 24)" > mesh/.env
docker compose -f mesh/docker-compose.yml --env-file mesh/.env up -d
curl http://<host>:8765/healthz   # → ok
```

Point every machine at it in `~/.omp/agent/omp-messenger.json` (or per repo in `.omp/omp-messenger.json`, which is how a project pins its channel):

```json
{ "mesh": { "url": "ws://<host>:8765", "channel": "main" } }
```

Put the token in `~/.omp/agent/messenger/mesh.token` (mode 0600), or set `mesh.token` (a literal or `$ENV_NAME`), or export `OMP_MESSENGER_MESH_TOKEN`. `OMP_MESSENGER_MESH_URL` overrides the file URL. Without `mesh.url` the plugin uses the local filesystem mesh exactly as before.

`omp_messenger({ action: "channels" })` lists channels; `join { channel }` creates or joins one. The status bar shows `⚡<channel>` in mesh mode (`⚡<channel>…` while reconnecting). Set `{ "crew": { "team": { "enabled": false } } }` to switch the Team layer off.

List available crew agents with `omp_messenger({ action: "crew.agents" })`.

To customize an agent for one project, copy it to `.omp/messenger/crew/agents/` and edit it.

## Quick Start

Once joined (manually or via `autoRegister` config), agents can coordinate:

```typescript
omp_messenger({ action: "join" })
omp_messenger({ action: "reserve", paths: ["src/auth/"], reason: "Refactoring" })
omp_messenger({ action: "send", to: "GoldFalcon", message: "auth is done" })
omp_messenger({ action: "release" })
omp_messenger({ action: "leave" })
```

For multi-agent task orchestration from a PRD:

```typescript
omp_messenger({ action: "plan" })                       // Planner analyzes codebase, creates tasks
omp_messenger({ action: "work", autonomous: true })      // Workers execute tasks in waves until done
omp_messenger({ action: "review", target: "task-1" })    // Reviewer checks implementation
```

## Features

**Living Presence** - Status indicators (active, idle, away, stuck), tool call counts, token usage, and auto-generated status messages like "on fire" or "debugging...". Your agent name appears in the status bar: `msg: SwiftRaven (2 peers) ●3`

**Activity Feed** - Unified timeline of edits, commits, test runs, messages, and task events. Query with `{ action: "feed" }`.

**Discovery** - Agents register with memorable themed names (SwiftRaven, LunarDust, OakTree). See who's active, what they're working on, which model and git branch they're on.

**Messaging** - Send messages between agents. Recipients wake up immediately and see the message as a steering prompt.

**File Reservations** - Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases on `leave` or exit.

**Stuck Detection** - Agents idle too long with an open task or reservation are flagged as stuck. Peers get a notification.

**Human as Participant** - Your interactive pi session appears in the agent list with `(you)`. Same activity tracking, same status messages. Chat from the overlay.

## Chat Overlay

`/messenger` opens an interactive overlay with agent presence, activity feed, and chat:

<img width="1198" height="1020" alt="omp-messenger crew overlay" src="https://github.com/user-attachments/assets/d66e5d71-5ed9-4702-9f56-9ca3f0e9c584" />

Chat input supports `@Name msg` for DMs and `@all msg` for broadcasts. Text without `@` broadcasts from the Agents tab or DMs the selected agent tab.

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch tabs (Agents, Crew, agent DMs, All) |
| `↑` `↓` | Scroll history / navigate crew tasks |
| `Enter` | Send message |
| `Esc` | Close |

## Crew: Task Orchestration

Crew turns a PRD into a dependency graph of tasks, then executes them in parallel waves.

Crew logs are per project, under that project's working directory: `.omp/messenger/crew/`. For example, if you run Crew from `/path/to/my-app`, the planner log lives at `/path/to/my-app/.omp/messenger/crew/planning-progress.md`.

### Workflow

1. **Plan** — Planner explores the codebase and PRD, drafts tasks with dependencies. A reviewer checks the plan; the planner refines until SHIP or `maxPasses` is reached. History is stored in `planning-progress.md`.
2. **Work** — Workers implement ready tasks (all dependencies met) in parallel waves. A single `work` call runs one wave. `autonomous: true` runs waves back-to-back until everything is done or blocked. Each completed task gets an automatic reviewer pass — SHIP keeps it done, NEEDS_WORK resets it for retry with feedback, MAJOR_RETHINK blocks it. Controlled by `review.enabled` and `review.maxIterations`.
3. **Review** — Manual review of a specific task or the plan: `omp_messenger({ action: "review", target: "task-1" })`. Returns SHIP, NEEDS_WORK, or MAJOR_RETHINK with detailed feedback.

No special PRD format required — the planner auto-discovers `PRD.md`, `SPEC.md`, `DESIGN.md`, etc. in your project root and `docs/`. Or skip the file entirely:

```typescript
omp_messenger({ action: "plan", prompt: "Scan the codebase for bugs" })

// Plan + auto-start autonomous work when planning completes
omp_messenger({ action: "plan" })  // auto-starts workers (default)
```

### Wave Execution

Tasks form a dependency graph. Independent tasks run concurrently:

```
Wave 1:  task-1 (no deps)  ─┐
         task-3 (no deps)  ─┤── run in parallel
                             │
Wave 2:  task-2 (→ task-1) ─┤── task-1 done, task-2 unblocked
         task-4 (→ task-3) ─┘── task-3 done, task-4 unblocked

Wave 3:  task-5 (→ task-2, task-4) ── both deps done
```

The planner structures tasks to maximize parallelism. Foundation work has no dependencies and starts immediately. Features that don't touch each other get separate chains. Autonomous mode stops when all tasks are done or blocked.

### Crew Skills

Workers follow the same join/read/implement/commit/release protocol regardless of the task — what changes between tasks is domain knowledge. Crew skills let workers acquire that knowledge on demand.

Skills are discovered from three locations (later sources override earlier by name):

1. **User skills** — `~/.omp/agent/skills/` (omp's standard `dir/SKILL.md` format)
2. **Extension skills** — `crew/skills/` within the extension (flat `.md` files)
3. **Project skills** — `.omp/messenger/crew/skills/` in your project root (flat `.md` files)

The planner sees a compact index of all discovered skills and can tag tasks with relevant ones. Workers see tagged skills as "Recommended for this task" with the full catalog under "Also available", and load what they need via `read()`. Zero tokens spent until a worker actually needs the knowledge.

To add a project-level skill, drop a `.md` file in `.omp/messenger/crew/skills/`:

```markdown
---
name: our-api-patterns
description: REST API conventions for this project — auth, pagination, error shapes.
---

# API Patterns

Always use Bearer token auth. Paginate with cursor-based `?after=` params.
Error responses use `{ error: { code, message, details? } }` shape.
```

Any skills you already have in `~/.omp/agent/skills/` are automatically available to crew workers — no setup needed.

### Team Layer

Team is an optional layer around Crew. Crew still plans and executes tasks; Team adds project-local roles, a charter, durable memory, reusable JSON profiles, and high-risk approval gates. Active Team state lives in `.omp/messenger/team/`. Reusable profiles live in `~/.omp/agent/messenger/team-profiles/`.

Most users should talk to their agent in plain language:

```text
Use the review squad for this cleanup.
Use a migration team and pause before risky database changes.
Research this first, then plan the implementation.
Approve the auth API task.
Reject the migration task; it needs rollback tests.
```

The agent maps those requests to Team actions. If a task needs approval, the agent should ask in plain language and continue after you approve. The tool calls are mainly for agents and power users:

```typescript
omp_messenger({ action: "team.setup", name: "migration-squad" })
omp_messenger({ action: "team.memory.note", type: "decision", message: "Auth API changes require reviewer sign-off." })
omp_messenger({ action: "team.roles" })
omp_messenger({ action: "team.status" })
```

`team.setup` activates the profile, saves an editable JSON copy if needed, creates a starter charter when the project does not have one, and returns the next planning/status commands.

When Team is active, planner task JSON may include `role` and `riskLabels`. Tasks persist those as `role`, `risk_labels`, and `approval`; existing tasks without those fields still work. Workers receive bounded Team role, charter, memory, and approval context. `work` skips tasks that require approval but are not approved and returns pending approvals under `needsApproval`; rejected tasks are surfaced separately with `task.revise` / `task.revise-tree` guidance.

Team's built-in role names follow the packaged `pi-subagents` vocabulary where possible: `context-builder`, `delegate`, `oracle`, `planner`, `researcher`, `reviewer`, `scout`, and `worker`. Roles resolve from those built-in defaults, the active profile, and optional filesystem metadata from `pi-subagents` markdown files when present. `omp-messenger` only reads those files; it does not require or call the subagent extension, and Crew still uses its own Crew agents for execution.

Built-in sample profiles are available immediately and are saved as editable JSON the first time you activate them:

```typescript
omp_messenger({ action: "team.setup", name: "migration-squad" }) // migrations with approval gates
omp_messenger({ action: "team.setup", name: "review-squad" })    // scout/reviewer/worker cleanup flow
omp_messenger({ action: "team.setup", name: "research-squad" })  // research-first planning flow
```

A saved profile looks like this:

```json
{
  "name": "migration-squad",
  "description": "Scout, implement, and review high-risk migrations with lead approval gates",
  "roles": {
    "scout": { "description": "Map affected schemas, APIs, and rollback paths before implementation" },
    "worker": { "description": "Implement the approved migration in small, reversible steps" },
    "reviewer": { "description": "Review migration safety, compatibility, rollback, and tests" }
  },
  "approval": { "mode": "risk-labels", "labels": ["database", "migration", "destructive", "api-contract"] },
  "memory": { "inject": ["decision", "interface", "risk", "handoff"], "maxCharsPerType": 4000 }
}
```

### Crew Configuration

Crew spawns multiple LLM sessions in parallel — it can burn tokens fast. Start with a cheap worker model and scale up once you've seen the workflow. Add this to `~/.omp/agent/omp-messenger.json`:

```json
{ "crew": { "models": { "worker": "claude-haiku-4-5" } } }
```

By default, Crew agents inherit the host session model unless a task, request, role, config, or agent frontmatter model says otherwise. Override per-role as needed:

```json
{
  "crew": {
    "models": {
      "worker": "claude-haiku-4-5",
      "planner": "claude-sonnet-4-6",
      "reviewer": "claude-sonnet-4-6"
    }
  }
}
```

Model strings accept `provider/model` format for explicit provider selection and `:level` suffix for inline thinking control. These work anywhere a model is specified — config, frontmatter, or per-task override:

```json
{
  "crew": {
    "models": {
      "worker": "anthropic/claude-haiku-4-5",
      "planner": "openrouter/anthropic/claude-sonnet-4:high"
    }
  }
}
```

The `:level` suffix and the `thinking.<role>` config are independent — if both are set, the suffix takes precedence and the `--thinking` flag is skipped to avoid double-application.

Full config reference (all fields optional — only set what you want to change):

```json
{
  "crew": {
    "concurrency": { "workers": 2, "max": 10 },
    "coordination": "chatty",
    "models": { "worker": "claude-haiku-4-5" },
    "review": { "enabled": true, "maxIterations": 3 },
    "planning": { "maxPasses": 1 },
    "work": {
      "maxAttemptsPerTask": 5,
      "maxWaves": 50
    }
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `concurrency.workers` | Default parallel workers per wave | `2` |
| `concurrency.max` | Maximum workers allowed (hard ceiling is 10) | `10` |
| `dependencies` | Dependency scheduling mode: `advisory` or `strict` | `"advisory"` |
| `coordination` | Worker coordination level: `none`, `minimal`, `moderate`, `chatty` | `"chatty"` |
| `messageBudgets` | Max outgoing messages per worker per level (sends rejected after limit) | `{ none: 0, minimal: 2, moderate: 5, chatty: 10 }` |
| `models.planner` | Model for planner agent | host session model, then agent frontmatter |
| `models.worker` | Model for workers (overridden by per-task or per-wave `model` param) | host session model, then agent frontmatter |
| `models.reviewer` | Model for reviewer agent | host session model, then agent frontmatter |
| `models.analyst` | Model for analyst (plan-sync) agent | host session model, then agent frontmatter |
| `thinking.planner` | Thinking level for planner agent | (from frontmatter) |
| `thinking.worker` | Thinking level for worker agents | (from frontmatter) |
| `thinking.reviewer` | Thinking level for reviewer agents | (from frontmatter) |
| `thinking.analyst` | Thinking level for analyst agents | (from frontmatter) |
| `review.enabled` | Auto-review after task completion | `true` |
| `review.maxIterations` | Max review/fix cycles per task | `3` |
| `planning.maxPasses` | Max planner/reviewer refinement passes | `1` |
| `work.maxAttemptsPerTask` | Auto-block after N failures | `5` |
| `work.maxWaves` | Max autonomous waves | `50` |
| `work.shutdownGracePeriodMs` | Grace period before a worker is aborted on shutdown | `30000` |
| `artifacts.enabled` | Write compact Crew debug artifacts | `true` |
| `artifacts.cleanupDays` | Retention setting for Crew artifacts | `7` |

### Default Agent Models

Each crew agent ships with a fallback model in its frontmatter. Override any role via `crew.models.<role>` in config:

| Agent | Role | Default Model |
|-------|------|---------------|
| `crew-planner` | planner | `anthropic/claude-opus-4-6` |
| `crew-worker` | worker | `anthropic/claude-haiku-4-5` |
| `crew-reviewer` | reviewer | `anthropic/claude-opus-4-6` |
| `crew-plan-sync` | analyst | `anthropic/claude-haiku-4-5` |

Agent definitions live in `agents/` within the extension. To customize one for a project, copy it to `.omp/messenger/crew/agents/` and edit the frontmatter — project-level agents override extension defaults by name. Agents support `thinking: <level>` in frontmatter (off, minimal, low, medium, high, xhigh). Config `thinking.<role>` overrides the frontmatter value.

## API Reference

### Coordination

| Action | Description |
|--------|-------------|
| `join` | Join the agent mesh |
| `leave` | Leave the mesh for the current session |
| `list` | List agents with presence info |
| `status` | Show your status or crew progress |
| `whois` | Detailed info about an agent (`name` required) |
| `feed` | Show activity feed (`limit` optional, default: 20) |
| `set_status` | Set custom status message (`message` optional — omit to clear) |
| `send` | Send DM (`to` + `message` required) |
| `broadcast` | Broadcast to all (`message` required) |
| `reserve` | Reserve files (`paths` required, `reason` optional) |
| `release` | Release reservations (`paths` optional — omit to release all) |
| `rename` | Change your name (`name` required) |

### Crew

| Action | Description |
|--------|-------------|
| `plan` | Create plan from PRD or inline prompt (`prd`, `prompt` optional — auto-discovers PRD if omitted, auto-starts workers unless `autoWork: false`) |
| `work` | Run ready tasks (`autonomous`, `concurrency` optional) |
| `work.stop` | Stop autonomous work for the current project |
| `review` | Review implementation (`target` task ID required) |
| `task.list` | List all tasks |
| `task.show` | Show task details (`id` required) |
| `task.start` | Start a task (`id` required) |
| `task.approve` | Approve an approval-gated task (`id` required) |
| `task.reject` | Reject an approval-gated task (`id` required, `reason` optional) |
| `task.done` | Complete a task (`id` required, `summary` optional) |
| `task.block` | Block a task (`id` + `reason` required) |
| `task.unblock` | Unblock a task (`id` required) |
| `task.ready` | List tasks ready to work |
| `task.reset` | Reset a task (`id` required, `cascade` optional) |
| `crew.status` | Overall crew status |
| `crew.validate` | Validate plan dependencies |
| `crew.agents` | List available crew agents |

### Team

| Action | Description |
|--------|-------------|
| `team.setup` | Activate a profile, create a starter charter if missing, and show next steps (`name` optional, defaults to `migration-squad`) |
| `team.profile.list` | List built-in samples and saved reusable JSON team profiles |
| `team.profile.use` | Activate a profile (`name` required; saves a sample/default profile if missing) |
| `team.profile.save` | Save the active profile under `name` |
| `team.charter.show` | Show the project team charter |
| `team.charter.create` | Create or replace the charter (`name` + `message` required) |
| `team.charter.update` | Append a charter update (`message` required) |
| `team.memory.note` | Append team memory (`type`: `decision`, `interface`, `risk`, or `handoff`; `message` required) |
| `team.memory.list` | List team memory (`type` and `limit` optional) |
| `team.roles` | Resolve Team roles from packaged-vocabulary defaults, profile config, and optional subagent metadata |
| `team.status` | Summarize team/profile/charter, roles, memory counts, and needs-lead tasks |

Approval-gated tasks use the Crew task commands `task.approve` and `task.reject`. Rejected tasks stay blocked from work and are surfaced with `task.revise` / `task.revise-tree` next steps.

### Swarm (Spec-Based)

| Action | Description |
|--------|-------------|
| `swarm` | Show swarm task status |
| `claim` | Claim a task (`taskId` required) |
| `unclaim` | Release a claim (`taskId` required) |
| `complete` | Complete a task (`taskId` required) |

## Configuration

Create `~/.omp/agent/omp-messenger.json`:

```json
{
  "autoRegister": false,
  "autoRegisterPaths": ["~/projects/team-collab"],
  "scopeToFolder": false,
  "nameTheme": "default",
  "stuckThreshold": 900,
  "stuckNotify": true,
  "stuckWakeAgent": null,
  "autoOverlayPlanning": true
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup | `false` |
| `autoRegisterPaths` | Folders where auto-join is enabled (supports `*` globs) | `[]` |
| `scopeToFolder` | Only see agents in same directory | `false` |
| `nameTheme` | Name theme: `default`, `nature`, `space`, `minimal`, `custom` | `"default"` |
| `nameWords` | Custom theme words: `{ adjectives: [...], nouns: [...] }` | — |
| `feedRetention` | Max events kept in activity feed | `50` |
| `stuckThreshold` | Seconds of inactivity before stuck detection | `900` |
| `stuckNotify` | Show notification when a peer appears stuck | `true` |
| `stuckWakeAgent` | Agent name that receives a steering turn when a peer first becomes stuck; `null` disables model wakeups | `null` |
| `autoStatus` | Auto-generate status messages from activity | `true` |
| `autoOverlay` | Auto-open overlay when autonomous crew work starts | `true` |
| `autoOverlayPlanning` | Auto-open Crew overlay when planning starts or is restored in-progress | `true` |
| `crewEventsInFeed` | Include crew task events in activity feed | `true` |
| `contextMode` | Context injection level: `full`, `minimal`, `none` | `"full"` |

Config priority: project `.omp/omp-messenger.json` > user `~/.omp/agent/omp-messenger.json` > `~/.omp/agent/settings.json` `"messenger"` key > defaults.

## How It Works

omp-messenger is an [oh-my-pi](https://github.com/can1357/oh-my-pi) plugin whose extension hooks into the agent lifecycle. It uses `pi.on("tool_call")` and `pi.on("tool_result")` to track activity — every edit, commit, and test run gets logged. `pi.on("session_start")` handles auto-registration, `pi.on("session_shutdown")` cleans up, and `pi.on("agent_end")` drives autonomous crew mode by checking for ready tasks after each agent turn.

Incoming messages wake the receiving agent via `pi.sendMessage()` with `triggerTurn: true` and `deliverAs: "aside"` — a non-interrupting delivery that starts a turn when the agent is idle and otherwise folds in at the next step boundary. Urgent crew notices (shutdown requests) use `deliverAs: "steer"`. File reservations are enforced by returning `{ block: true }` from a `tool_call` hook on write/edit operations. The `/messenger` overlay uses `ctx.ui.custom()` for the chat TUI, and `ctx.ui.setStatus()` keeps the status bar updated with peer count, unread messages, and the mesh channel.

Crew workers run as in-process omp subagents through the SDK injected into the extension (`runSubprocess` / `runSubagentFollowUpTurn`), with the agent's system prompt, model, and tool restrictions from its `.md` definition. A worker's session file lives under `<project>/.omp/messenger/crew/artifacts/<Name>.jsonl`, which is how the worker's own extension instance learns its mesh name and auto-joins. Progress comes from the SDK's `onProgress` callback — the overlay shows each worker's current tool, call count, and token usage in real time — and workers also appear in omp's Agent Hub. Aborting a work run triggers graceful shutdown: each worker receives an urgent mesh message asking it to stop, followed by a grace period before its run is aborted. Lobby workers stay alive as idle omp subagents and receive task assignments through follow-up turns.

Coordination goes through a `Mesh` seam with two implementations. The default filesystem mesh keeps shared state (registry, inboxes, swarm claims/completions) in `~/.omp/agent/messenger/` (channels other than `main` under `channels/<name>/`) and detects dead agents via PID checks. In mesh mode every session is a pure outbound WebSocket client of the `mesh/server.ts` process — the server holds presence, claims, and per-channel completions (optionally persisted to sqlite on a volume), fans out presence with pub/sub topics, and clients reconnect with backoff and re-assert their registration and claims. Activity feed and crew data stay project-scoped under `.omp/messenger/`.

## Credits

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** by [@doodlestein](https://x.com/doodlestein) — Inspiration for agent-to-agent messaging
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
