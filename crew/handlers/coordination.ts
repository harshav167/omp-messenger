/**
 * Crew - Worker Coordination
 *
 * Builds dependency sections, coordination context (concurrent tasks,
 * recent activity, ready tasks), and coordination instructions for
 * worker prompts. All functions use static data available at prompt-build
 * time — no runtime worker state.
 */

import type { Task } from "../types.ts";
import { isTeamEnabled, type CrewConfig } from "../utils/config.ts";
import { readFeedEvents, type FeedEvent } from "../../feed.ts";
import * as store from "../store.ts";
import * as teamStore from "../team/store.ts";

interface CoordinationPromptOptions {
  readOnly?: boolean;
}

// =============================================================================
// Dependency Section
// =============================================================================

export function buildDependencySection(cwd: string, task: Task, config: CrewConfig, options: CoordinationPromptOptions = {}): string {
  if (config.dependencies === "advisory") {
    const lines: string[] = [
      "## Dependency Status\n",
      "Your task has dependencies on other tasks. Some may not be complete yet — this is expected. Use the coordination system to work through it.",
      "",
    ];

    for (const depId of task.depends_on) {
      const dep = store.getTask(cwd, depId);
      if (!dep) {
        lines.push(`- ○ ${depId} — not yet started`);
        continue;
      }

      if (dep.status === "done") {
        const summary = dep.summary ? ` ${dep.summary}` : "";
        lines.push(`- ✓ ${dep.id} (${dep.title}) — done${summary ? `.${summary}` : ""}`);
      } else if (dep.status === "in_progress") {
        const worker = dep.assigned_to ? `, worker: ${dep.assigned_to}` : "";
        lines.push(`- ⟳ ${dep.id} (${dep.title}) — in progress${worker}`);
      } else {
        lines.push(`- ○ ${dep.id} (${dep.title}) — not yet started`);
      }
    }

    lines.push(
      "",
      "**Working with pending dependencies:**",
      "- Check if the dependency's output files exist. If yes, import and use them.",
      "- If not, define what you need locally based on your task spec. Your spec describes the interfaces.",
    );
    if (config.coordination !== "none") {
      lines.push("- DM in-progress workers for API details they're building.");
    }
    if (!options.readOnly) lines.push("- Reserve your files before editing to prevent conflicts.");
    lines.push(
      "- Do NOT block yourself because a dependency isn't done. Work around it.",
      options.readOnly
        ? "- Log findings, assumptions, and handoff notes in your progress for later reconciliation."
        : "- Log any local definitions in your progress for later reconciliation.",
    );

    return lines.join("\n") + "\n\n";
  }

  const level = config.coordination;
  const lines: string[] = ["## Dependencies\n", "Your task depends on these completed tasks:"];

  for (const depId of task.depends_on) {
    const dep = store.getTask(cwd, depId);
    if (!dep) {
      lines.push(`- ${depId}`);
      continue;
    }

    if (level === "minimal") {
      lines.push(`- ${depId}: ${dep.title}`);
    } else {
      const summary = dep.summary || "(no summary)";
      lines.push(`- ${depId} (${dep.title}): ${summary}`);
    }
  }

  return lines.join("\n") + "\n\n";
}

// =============================================================================
// Coordination Context (concurrent tasks, recent activity, ready tasks)
// =============================================================================

const ACTIVITY_EVENT_TYPES = new Set<string>([
  "task.start", "task.done", "task.block", "task.reset",
  "reserve", "release", "message",
]);

function formatFeedTime(isoTs: string): string {
  const d = new Date(isoTs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatFeedVerb(type: string): string {
  switch (type) {
    case "task.start": return "started";
    case "task.done": return "completed";
    case "task.block": return "blocked";
    case "task.reset": return "reset";
    case "reserve": return "reserved";
    case "release": return "released";
    default: return type;
  }
}

function formatActivityLine(event: FeedEvent): string {
  const time = formatFeedTime(event.ts);
  if (event.type === "message") {
    if (event.target) {
      return event.preview
        ? `${time} ${event.agent} → ${event.target}: ${event.preview}`
        : `${time} ${event.agent} → ${event.target}`;
    }
    return event.preview
      ? `${time} ${event.agent} ✦ ${event.preview}`
      : `${time} ${event.agent} ✦`;
  }
  const verb = formatFeedVerb(event.type);
  const target = event.target ? ` ${event.target}` : "";
  const preview = event.preview ? ` — ${event.preview}` : "";
  return `${time} ${event.agent} ${verb}${target}${preview}`;
}

export function buildCoordinationContext(
  cwd: string,
  task: Task,
  config: CrewConfig,
  concurrentTasks: Task[],
  options: CoordinationPromptOptions = {},
): string {
  if (config.coordination === "none") return "";

  const level = config.coordination;
  let out = "";

  if (concurrentTasks.length > 0) {
    out += `## Concurrent Tasks

These tasks are being worked on by other workers in this wave. Discover their agent names after joining the mesh via \`omp_messenger({ action: "list" })\`.

`;
    for (const t of concurrentTasks) {
      out += `- ${t.id}: ${t.title}\n`;
    }
    out += "\n";
  }

  if (level === "moderate" || level === "chatty") {
    const events = readFeedEvents(cwd, 20);
    const signal = events.filter(e => ACTIVITY_EVENT_TYPES.has(e.type)).slice(-8);
    if (signal.length > 0) {
      out += "## Recent Activity\n\n";
      for (const e of signal) {
        out += formatActivityLine(e) + "\n";
      }
      out += "\n";
    }
  }

  if (level === "chatty") {
    const concurrentIds = new Set(concurrentTasks.map(t => t.id));
    const ready = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" })
      .filter(t => t.id !== task.id && !concurrentIds.has(t.id));
    const claimable = ready.filter(t => !teamStore.taskNeedsApproval(cwd, t));
    const teamEnabled = isTeamEnabled(cwd);
    const needsApproval = teamEnabled ? ready.filter(t => teamStore.taskPendingApproval(cwd, t)) : [];
    const rejected = teamEnabled ? ready.filter(t => teamStore.taskNeedsRevision(cwd, t)) : [];
    if (claimable.length > 0) {
      out += `## Ready Tasks

${options.readOnly ? "After completing your current task, only claim one of these if it fits your read-only assignment:" : "After completing your current task, you can claim one of these:"}
`;
      for (const t of claimable) {
        const deps = t.depends_on.length > 0 ? ` (deps: ${t.depends_on.join(", ")})` : "";
        out += `- ${t.id}: ${t.title}${deps}\n`;
      }
      out += "\n";
    }
    if (needsApproval.length > 0) {
      out += `## Ready Tasks Needing Approval

These tasks are ready but require lead approval before anyone can claim them:
`;
      for (const t of needsApproval) out += `- ${t.id}: ${t.title} — approve with \`omp_messenger({ action: "task.approve", id: "${t.id}" })\`\n`;
      out += "\n";
    }
    if (rejected.length > 0) {
      out += `## Rejected Tasks Needing Revision

These tasks need revision before they can be approved or claimed:
`;
      for (const t of rejected) out += `- ${t.id}: ${t.title}${t.approval?.feedback ? ` — ${t.approval.feedback}` : ""} — revise with \`omp_messenger({ action: "task.revise", id: "${t.id}", prompt: "Address approval feedback" })\`\n`;
      out += "\n";
    }
  }

  return out;
}

// =============================================================================
// Coordination Instructions
// =============================================================================

export function buildCoordinationInstructions(config: CrewConfig, options: CoordinationPromptOptions = {}): string {
  const level = config.coordination;
  if (level === "none") return "";

  const budget = config.messageBudgets?.[level] ?? (level === "chatty" ? 10 : 5);

  if (level === "minimal") {
    if (options.readOnly) {
      return `## Coordination

**Message budget: ${budget} messages this session.** The system enforces this.

Use \`omp_messenger({ action: "list" })\` to see active workers if your investigation overlaps with their work. Message a worker only when you need concrete context or a handoff detail.

`;
    }

    return `## Coordination

**Message budget: ${budget} messages this session.** The system enforces this.

Before editing files, check if another worker has reserved them by running:

\`\`\`typescript
omp_messenger({ action: "list" })
\`\`\`

If a file you need is reserved by another worker, message them to coordinate:

\`\`\`typescript
omp_messenger({ action: "send", to: "<their-name>", message: "I need to modify <file> for my task, can we coordinate?" })
\`\`\`

Do NOT edit files reserved by another worker without coordinating first.

`;
  }

  let out = `## Coordination

**Message budget: ${budget} messages this session.** The system enforces this — sends are rejected after the limit.

**Broadcasts go to the team feed — only the user sees them live.** Other workers see your broadcasts in their initial context only. Use DMs for time-sensitive peer coordination.

`;

  out += options.readOnly
    ? `### Announce yourself
After joining the mesh and starting your task, announce what you are investigating:

\`\`\`typescript
omp_messenger({ action: "broadcast", message: "Starting <task-id> (<title>) — investigating <scope>" })
\`\`\`

`
    : `### Announce yourself
After joining the mesh and starting your task, announce what you're working on:

\`\`\`typescript
omp_messenger({ action: "broadcast", message: "Starting <task-id> (<title>) — will create <files>" })
\`\`\`

`;

  if (level === "chatty") {
    out += `### Coordinate with peers
If a concurrent task involves files or interfaces related to yours, send a brief DM. Only message when there's a concrete coordination need — shared files, interfaces, or blocking questions.

\`\`\`typescript
omp_messenger({ action: "send", to: "<peer-name>", message: "I'm exporting FormatOptions from types.ts — will you need it?" })
\`\`\`

### Responding to messages
If a peer asks you a direct question, reply briefly. Ignore messages that don't require a response. Do NOT start casual conversations.

`;
  }

  out += options.readOnly
    ? `### On completion
Announce what you found or recommend:

\`\`\`typescript
omp_messenger({ action: "broadcast", message: "Completed <task-id>: found <summary>" })
\`\`\`

`
    : `### On completion
Announce what you built:

\`\`\`typescript
omp_messenger({ action: "broadcast", message: "Completed <task-id>: <file> exports <symbols>" })
\`\`\`

### Reservations
Before editing files, check if another worker has reserved them via \`omp_messenger({ action: "list" })\`. If a file you need is reserved, message the owner to coordinate. Do NOT edit reserved files without coordinating first.

`;

  out += `### Questions about dependencies
If your task depends on a completed task and something about its implementation is unclear, read the code and the task's progress log at \`.omp/messenger/crew/tasks/<task-id>.progress.md\`. Dependency authors are from previous waves and are no longer in the mesh.

`;

  if (level === "chatty") {
    out += `### Claim next task
After completing your assigned task, check if there are ready tasks you can pick up:

\`\`\`typescript
omp_messenger({ action: "task.ready" })
\`\`\`

If a task is ready, claim it only if it matches your assignment mode. If \`task.start\` fails (another worker claimed it first or the task needs approval), check for other ready tasks. Only claim if your current task completed cleanly and quickly.

`;
  }

  return out;
}
