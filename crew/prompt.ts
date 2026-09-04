/**
 * Crew - Worker Prompt Builder
 *
 * Assembles the full prompt sent to a worker when it's assigned a task.
 * Pure function: reads from store, returns a string.
 */

import type { Task } from "./types.ts";
import type { CrewConfig } from "./utils/config.ts";
import type { CrewSkillInfo } from "./utils/discover.ts";
import { TEAM_MEMORY_TYPES, type TeamMemoryType, type TeamPromptContext } from "./team/types.ts";
import { isNonEditingTeamRole } from "./utils/team-roles.ts";
import * as store from "./store.ts";
import { buildDependencySection, buildCoordinationContext, buildCoordinationInstructions } from "./handlers/coordination.ts";

export function buildWorkerPrompt(
  task: Task,
  prdPath: string,
  cwd: string,
  config: CrewConfig,
  concurrentTasks: Task[],
  skills?: CrewSkillInfo[],
  teamContext?: TeamPromptContext,
): string {
  const taskSpec = store.getTaskSpec(cwd, task.id);
  const planSpec = store.getPlanSpec(cwd);
  const isNonEditingRole = isNonEditingTeamRole(teamContext?.role?.name);
  const mission = isNonEditingRole
    ? `Inspect this task as a read-only Team role. This overrides generic implementation protocol for this assignment:
1. Join the mesh
2. Read task spec to understand requirements
3. Start the task so Crew can track ownership
4. Inspect code, docs, and context without editing files
5. Record findings, plans, decisions, risks, or handoff notes in progress or Team memory
6. Mark complete with a concise summary of what you found or recommend`
    : `Implement this task following the crew-worker protocol:
1. Join the mesh
2. Read task spec to understand requirements
3. Start task and reserve files
4. Implement the feature
5. Commit your changes
6. Release reservations and mark complete`;

  let prompt = `# Task Assignment

**Task ID:** ${task.id}
**Task Title:** ${task.title}
**PRD:** ${prdPath}
${task.attempt_count >= 1 ? `**Attempt:** ${task.attempt_count + 1} (retry after previous attempt)` : ""}

## Your Mission

${mission}

`;

  const teamSection = buildTeamSection(task, teamContext);
  if (teamSection) {
    prompt += teamSection;
  }

  if (task.last_review) {
    prompt += `## ⚠️ Previous Review Feedback

**Verdict:** ${task.last_review.verdict}

${task.last_review.summary}

${task.last_review.issues.length > 0 ? `**Issues to fix:**\n${task.last_review.issues.map(i => `- ${i}`).join("\n")}\n` : ""}
${task.last_review.suggestions.length > 0 ? `**Suggestions:**\n${task.last_review.suggestions.map(s => `- ${s}`).join("\n")}\n` : ""}

**You MUST address the issues above in this attempt.**

`;
  }

  const progress = store.getTaskProgress(cwd, task.id);
  if (progress) {
    const lines = progress.trimEnd().split("\n");
    const capped = lines.length > 30 ? lines.slice(-30) : lines;
    const truncated = capped.join("\n");
    const omitted = lines.length > 30 ? `(${lines.length - 30} earlier entries omitted)\n` : "";
    prompt += `## Progress from Prior Attempts

${omitted}${truncated}

`;
  }

  if (task.depends_on.length > 0) {
    if (config.dependencies === "advisory" || config.coordination !== "none") {
      prompt += buildDependencySection(cwd, task, config, { readOnly: isNonEditingRole });
    } else {
      prompt += `## Dependencies

This task depends on: ${task.depends_on.join(", ")}
These tasks are already complete - you can reference their implementations.

`;
    }
  }

  const coordContext = buildCoordinationContext(cwd, task, config, concurrentTasks, { readOnly: isNonEditingRole });
  if (coordContext) {
    prompt += coordContext;
  }

  if (taskSpec && !taskSpec.includes("*Spec pending*")) {
    prompt += `## Task Specification

${taskSpec}

`;
  }

  if (planSpec && !planSpec.includes("*Spec pending*")) {
    const truncatedSpec = planSpec.length > 2000
      ? planSpec.slice(0, 2000) + `\n\n[Spec truncated - read full spec from .pi/messenger/crew/plan.md]`
      : planSpec;
    prompt += `## Plan Context

${truncatedSpec}
`;
  }

  const coordInstructions = buildCoordinationInstructions(config, { readOnly: isNonEditingRole });
  if (coordInstructions) {
    prompt += coordInstructions;
  }

  const skillsSection = buildSkillsSection(skills, task.skills, isNonEditingRole);
  if (skillsSection) {
    prompt += skillsSection;
  }

  return prompt;
}

const WORKER_HIDDEN_SKILLS = new Set(["pi-messenger-crew"]);

function buildTeamSection(task: Task, teamContext: TeamPromptContext | undefined): string | null {
  if (!teamContext) return null;

  let section = `## Team Context\n\n`;
  if (teamContext.team) {
    const profileText = teamContext.profile?.name && teamContext.profile.name !== teamContext.team.name
      ? ` (profile: ${teamContext.profile.name})`
      : "";
    section += `Active team: ${teamContext.team.name}${profileText}\n\n`;
  }

  if (task.role || teamContext.role) {
    section += `### Team Role\nYou are acting as the \`${task.role ?? teamContext.role?.name}\` role for this task.\n`;
    if (teamContext.role?.description) section += `Role description: ${teamContext.role.description}\n`;
    if (teamContext.role?.thinking) section += `Thinking default: ${teamContext.role.thinking}\n`;
    if (teamContext.role?.skills && teamContext.role.skills.length > 0) section += `Role skills: ${teamContext.role.skills.join(", ")}\n`;
    if (teamContext.role && isNonEditingTeamRole(teamContext.role.name)) {
      section += "This is a non-editing Team role. Do not edit files; report findings, plans, decisions, or handoff notes instead.\n";
    }
    if (teamContext.role?.prompt) {
      const prompt = teamContext.role.prompt.length > 2000
        ? teamContext.role.prompt.slice(0, 2000) + "\n[Role prompt truncated]"
        : teamContext.role.prompt;
      section += `\nRole working rules:\n${prompt}\n`;
    }
    section += "\n";
  }

  if (teamContext.charter) {
    const charter = teamContext.charter.length > 2500
      ? teamContext.charter.slice(0, 2500) + "\n[Team charter truncated]"
      : teamContext.charter;
    section += `### Team Charter\n${charter}\n\n`;
  }

  const memoryText = formatMemory(teamContext.memory);
  if (memoryText) section += memoryText;

  if (task.risk_labels && task.risk_labels.length > 0) {
    section += `### Risk Labels\n${task.risk_labels.join(", ")}\n\n`;
  }

  if (task.approval?.required) {
    section += `### Approval Policy\nLead approval required. Current status: ${task.approval.status}.\n`;
    if (task.approval.plan) section += `Approval plan: ${task.approval.plan}\n`;
    if (task.approval.feedback) section += `Approval feedback: ${task.approval.feedback}\n`;
    section += "\n";
  }

  return section;
}

function formatMemory(memory: TeamPromptContext["memory"]): string {
  const labels: Record<TeamMemoryType, string> = {
    decision: "Recent decisions",
    interface: "Interfaces",
    risk: "Risks",
    handoff: "Handoffs",
  };
  let text = "";
  for (const type of TEAM_MEMORY_TYPES) {
    const entries = memory[type];
    if (!entries || entries.length === 0) continue;
    text += `### ${labels[type]}\n`;
    for (const entry of entries.slice(-8)) {
      text += `- ${entry.message}${entry.taskId ? ` (${entry.taskId})` : ""}\n`;
    }
    text += "\n";
  }
  return text ? `### Team Memory\n${text}` : "";
}

function buildSkillsSection(
  skills: CrewSkillInfo[] | undefined,
  taskSkills: string[] | undefined,
  readOnly: boolean,
): string | null {
  if (!skills || skills.length === 0) return null;

  const visibleSkills = skills.filter(skill => !WORKER_HIDDEN_SKILLS.has(skill.name));
  if (visibleSkills.length === 0) return null;

  const recommended = new Set(taskSkills ?? []);
  const recSkills = visibleSkills.filter(s => recommended.has(s.name));
  const otherSkills = visibleSkills.filter(s => !recommended.has(s.name));

  let section = `## Available Skills

${readOnly ? "Read any skill that matches what you're investigating." : "Read any skill that matches what you're implementing."}

`;

  if (recSkills.length > 0) {
    section += "**Recommended for this task:**\n";
    for (const s of recSkills) {
      section += `  ${s.name} — ${s.description}\n    ${s.path}\n`;
    }
    section += "\n";
  }

  if (otherSkills.length > 0) {
    if (recSkills.length > 0) section += "**Also available:**\n";
    for (const s of otherSkills) {
      section += `  ${s.name} — ${s.description}\n    ${s.path}\n`;
    }
    section += "\n";
  }

  section += `To load a skill: read({ path: "<skill-path>" })\n`;

  return section;
}
