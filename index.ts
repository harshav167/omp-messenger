/**
 * omp-messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination - no daemon required.
 */

import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import type { OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { text as nativeText } from "@oh-my-pi/pi-tui/native/describe";
import {
  type MessengerState,
  type AgentRegistration,
  type AgentMailMessage,
  type ReservationConflict,
  MAX_CHAT_HISTORY,
  extractFolder,
  generateAutoStatus,
  computeStatus,
  agentHasTask,
  isMentioned,
  findReservationConflicts,
  LOCAL_HOST_ID,
} from "./lib.ts";
import * as handlers from "./handlers.ts";
import { MessengerOverlay, type OverlayCallbacks } from "./overlay.ts";
import { MessengerConfigOverlay } from "./config-overlay.ts";
import {
  loadConfig,
  loadGlobalConfig,
  matchesAutoRegisterPath,
  setAgentDirProvider,
  type MessengerConfig,
} from "./config.ts";
import { createMesh } from "./mesh/index.ts";
import type { Mesh } from "./mesh/types.ts";
import { normalizeCwd } from "./mesh/registration.ts";
import { executeCrewAction } from "./crew/index.ts";
import { setSdk } from "./crew/sdk.ts";
import { detectCrewIdentity } from "./crew/identity.ts";
import { logFeedEvent, pruneFeed } from "./feed.ts";
import type { CrewParams, Task } from "./crew/types.ts";
import {
  autonomousState,
  cancelPlanningRun,
  consumePendingAutoWork,
  consumePlanningOverlayPending,
  dismissPlanningOverlayRun,
  getPlanningOverlayPending,
  isPlanningForCwd,
  isPlanningStalled,
  markPlanningOverlayPending,
  planningState,
  restoreAutonomousState,
  restorePlanningState,
  stopAutonomous,
  isAutonomousForCwd,
} from "./crew/state.ts";
import { loadCrewConfig } from "./crew/utils/config.ts";
import * as crewStore from "./crew/store.ts";
import * as teamStore from "./crew/team/store.ts";
import { getLiveWorkers, onLiveWorkersChanged } from "./crew/live-progress.ts";
import { shutdownAllWorkers } from "./crew/agents.ts";
import { shutdownLobbyWorkers } from "./crew/lobby.ts";

/** Minimal Component wrapper for a fixed set of pre-rendered lines. */
function statusCard(lines: string[]) {
  return {
    render: (width: number) => lines.map((line) => truncateToWidth(line, width)),
    invalidate() {},
  };
}

/** Status header line: colored icon, accent title, dim meta — mirrors omp's renderStatusLine. */
function statusLine(
  opts: {
    icon?: "pending" | "success" | "error" | "warning";
    glyph?: string;
    title: string;
    meta?: string[];
  },
  theme: Theme,
): string {
  const iconColor = {
    pending: "dim",
    success: "success",
    error: "error",
    warning: "warning",
  } as const;
  const icon =
    opts.glyph ?? (opts.icon ? theme.fg(iconColor[opts.icon], theme.status[opts.icon]) : "");
  const meta = opts.meta?.length ? theme.fg("dim", `  ${opts.meta.join(" · ")}`) : "";
  return `${icon} ${theme.fg("accent", opts.title)}${meta}`.trimEnd();
}

/** Quoted body lines with a dim border glyph, collapsing long messages (hub renderer parity). */
function ircQuoteBody(text: string, theme: Theme, collapsedLines = 3): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const collapsed = lines.length > collapsedLines;
  const visible = collapsed ? lines.slice(0, collapsedLines) : lines;
  const rows = visible.map((line) => `  ${theme.fg("dim", "│")} ${line}`);
  if (collapsed) rows.push(theme.fg("dim", `  … +${lines.length - collapsedLines} more lines`));
  return rows;
}

/** Display target for send/broadcast: broadcasts read "all", matching hub's card. */
function hubTarget(call: CrewParams): string {
  return call.action === "broadcast"
    ? "all"
    : (Array.isArray(call.to) ? call.to.join(", ") : call.to) || "…";
}

/** Status-line title for non-messaging actions so every tool call renders visibly. */
function actionTitle(call: CrewParams | undefined): string {
  const action = call?.action ?? "";
  switch (action) {
    case "":
      return "IRC status";
    case "join":
      return "IRC join";
    case "leave":
      return "IRC leave";
    case "channels":
    case "channels.join":
    case "channels.leave":
    case "channels.delete":
      return "IRC channels";
    case "peers":
      return "IRC peers";
    case "whois":
      return `IRC whois ${call?.name ?? ""}`.trim();
    case "reserve":
      return "IRC reserve";
    case "release":
      return "IRC release";
    case "feed":
      return "IRC feed";
    default:
      return action.startsWith("task.") ||
        action.startsWith("team.") ||
        action === "plan" ||
        action === "work" ||
        action === "review"
        ? `Crew ${action}`
        : `omp-messenger ${action}`;
  }
}

/** Status-line meta for non-messaging actions: channels, paths, target name. */
function actionMeta(call: CrewParams | undefined): string[] {
  const meta: string[] = [];
  if (call?.channels?.length) meta.push(call.channels.map((c) => `#${c}`).join(" "));
  else if (call?.channel) meta.push(`#${call.channel}`);
  if (call?.paths?.length) meta.push(call.paths.join(", "));
  return meta;
}

function unwrapEditHeaderPath(targetPath: string): string {
  const trimmed = targetPath.trimEnd();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return targetPath;
  const inner = trimmed.slice(1, -1);
  const tag = /#[0-9A-Fa-f]{4}$/.exec(inner);
  const path = tag ? inner.slice(0, tag.index) : inner;
  return path && (tag || !path.includes("#")) ? path : targetPath;
}

function normalizeEditPath(raw: string): string {
  let path = raw
    .trim()
    .replace(/^\*{3}\s*(?:(?:Add|Update|Delete)\s+File|Move\s+to)\s*:\s*/i, "")
    .trim();
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(path);
      if (typeof parsed === "string") path = parsed;
    } catch {
      // Keep the authored target when a partial payload has not closed its JSON string cleanly.
    }
  } else if (path.length >= 2 && path.startsWith("'") && path.endsWith("'")) {
    path = path.slice(1, -1);
  }
  return path;
}

/** Read only target declarations from the public edit grammars; never execute the payload. */
function freeformEditTargets(input: string, mode: "hashline" | "apply_patch" | "sloppy"): string[] {
  const targets: string[] = [];
  const add = (raw: string) => {
    const path = normalizeEditPath(raw);
    if (path) targets.push(path);
  };
  let hashlineSection = false;
  for (const line of input.split("\n")) {
    if (mode === "hashline") {
      const header = /^\s*\[([^\]\r\n]+)\]\s*$/.exec(line);
      if (header) {
        hashlineSection = true;
        add(header[1].replace(/#[0-9A-Fa-f]{4}$/, ""));
      } else if (hashlineSection) {
        const move = /^\s*MV\s+(\S.*?)\s*$/.exec(line);
        if (move) add(move[1]);
      }
    } else if (mode === "sloppy") {
      const header = /^\s*\*{3}\s+Edit\s+File\s*:\s*(.*?)\s*$/i.exec(line);
      if (header?.[1]) add(header[1].replace(/\s+all$/i, ""));
    } else {
      const header = /^\s*\*{3}\s+(?:Add|Update|Delete)\s+File\s*:\s*(\S.*?)\s*$/i.exec(line);
      const move = /^\s*\*{3}\s+Move\s+to\s*:\s*(\S.*?)\s*$/i.exec(line);
      if (header) add(header[1]);
      if (move) add(move[1]);
    }
  }
  return targets;
}

export default function piMessengerExtension(pi: ExtensionAPI) {
  setAgentDirProvider(() => pi.pi.getAgentDir());
  setSdk(() => pi.pi);
  const z = pi.zod;
  let overlayTui: TUI | null = null;
  let overlayHandle: OverlayHandle | null = null;
  let overlayOpening = false;
  let overlayEpoch = 0;
  let ownsCrewLifecycle = false;
  let ownedPlanningRunId: string | null = null;
  let ownerSessionId: string | undefined;
  let ownedWorkAbort = new AbortController();

  // ===========================================================================
  // State & Configuration
  // ===========================================================================

  let config: MessengerConfig = loadGlobalConfig();

  const state: MessengerState = {
    agentName: process.env.OMP_AGENT_NAME || "",
    explicitName: !!process.env.OMP_AGENT_NAME,
    channels: config.mesh.channels,
    isCrewWorker: false,
    messagesSent: 0,
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "",
    cwd: "",
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: config.scopeToFolder,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  };

  const nameTheme = { theme: config.nameTheme, customWords: config.nameWords };

  const baseDir = process.env.OMP_MESSENGER_DIR || join(homedir(), ".omp", "agent", "messenger");

  // ===========================================================================
  // Message Delivery
  // ===========================================================================

  function deliverMessage(msg: AgentMailMessage): void {
    // Store in chat history (keyed by sender)
    let history = state.chatHistory.get(msg.from);
    if (!history) {
      history = [];
      state.chatHistory.set(msg.from, history);
    }
    history.push(msg);
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    // Increment unread count
    const current = state.unreadCounts.get(msg.from) ?? 0;
    state.unreadCounts.set(msg.from, current + 1);

    // Trigger overlay re-render if open
    overlayTui?.requestRender();

    // Build message content with optional context
    // Detect if this is a new agent identity (first contact OR same name but different session)
    const sender = mesh.peers().find((a) => a.name === msg.from);
    const senderSessionId = sender?.sessionId;
    const prevSessionId = state.seenSenders.get(msg.from);
    const isNewIdentity = !prevSessionId || (senderSessionId && prevSessionId !== senderSessionId);

    // Update seen senders with current sessionId (only if we could look it up)
    if (senderSessionId) {
      state.seenSenders.set(msg.from, senderSessionId);
    }

    let content = "";

    // Add sender details on new identity (first contact or agent restart with same name)
    if (isNewIdentity && config.senderDetailsOnFirstContact && sender) {
      const folder = extractFolder(sender.cwd);
      const locationPart = sender.gitBranch ? `${folder} on ${sender.gitBranch}` : folder;
      content += `*${msg.from} is in ${locationPart} (${sender.model})*\n\n`;
    }

    const isPost = msg.kind === "post";
    const channelName = msg.channel ?? "main";
    const replyHint = !config.replyHint
      ? ""
      : isPost
        ? ` — reply in #${channelName}: omp_messenger({ action: "broadcast", channel: "${channelName}", message: "@${msg.from} ..." })`
        : ` — reply: omp_messenger({ action: "send", to: "${msg.from}", message: "..." })`;
    const heading = isPost
      ? `**#${channelName} · ${msg.from}**${isMentioned(msg.mentions, state.agentName) ? " (mentions you)" : ""}`
      : `**Message from ${msg.from}**`;

    content += `${heading}${replyHint}\n\n${msg.text}`;

    if (msg.replyTo) {
      content = `*(reply to ${msg.replyTo.substring(0, 8)})*\n\n${content}`;
    }

    // One record type for every peer message: omp's own `irc:incoming`, so the transcript
    // renders the same "IRC ← name" card whether the receiver was busy or idle.
    //   default → steer + triggerTurn: interrupts a running turn, and on an idle session
    //     starts a fresh one — including sessions the user stopped with Esc. omp's SDK
    //     reserves that wake for real peer IRC records (the irc:incoming carve-out in
    //     #resumeStrandedIrcAsides); `aside` would fold silently into context there.
    //   gentle → aside: explicitly non-interrupting; rides the step boundary while busy
    //     and stays user-driven (folds into context) after a deliberate Esc.
    //   channel post that doesn't mention us → ambient: it must neither interrupt nor
    //     wake. `aside` starts a turn on an idle session, so an idle receiver gets a plain
    //     display append without a turn instead; a busy one gets `aside`. When the session
    //     state is unknown (stale ctx), `aside` errs toward not interrupting work.
    let delivery: { triggerTurn: boolean; deliverAs?: "steer" | "aside" };
    if (isPost && msg.gentle) {
      let idle = false;
      try {
        idle = latestCtx?.isIdle() ?? false;
      } catch {
        idle = false;
      }
      delivery = idle ? { triggerTurn: false } : { triggerTurn: false, deliverAs: "aside" };
    } else {
      delivery = msg.gentle
        ? { triggerTurn: true, deliverAs: "aside" }
        : { triggerTurn: true, deliverAs: "steer" };
    }
    pi.sendMessage(
      {
        customType: "irc:incoming",
        content,
        display: true,
        details: {
          id: msg.id,
          from: msg.from,
          message: msg.text,
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.channel ? { channel: msg.channel } : {}),
          ...(isPost ? { kind: "post", mentions: msg.mentions ?? [] } : {}),
        },
      },
      delivery,
    );
  }

  let mesh: Mesh = createMesh({
    config,
    base: baseDir,
    state,
    deliver: deliverMessage,
    onStatusChange: () => {
      updateStatusFromBackground();
    },
  });

  // ===========================================================================
  // Stuck Detection
  // ===========================================================================

  const notifiedStuck = new Set<string>();

  function checkStuckAgents(ctx: ExtensionContext, peers: AgentRegistration[]): void {
    if (!config.stuckNotify || !ctx.hasUI || !state.registered) return;

    const thresholdMs = config.stuckThreshold * 1000;
    const allClaims = mesh.claims();
    const tasksByCwd = new Map<string, Task[]>();
    const currentlyStuck = new Set<string>();

    for (const agent of peers) {
      let tasks: Task[] = [];
      if (agent.hostId === LOCAL_HOST_ID) {
        tasks = tasksByCwd.get(agent.cwd) ?? crewStore.getTasks(agent.cwd);
        tasksByCwd.set(agent.cwd, tasks);
      }
      const hasTask = agentHasTask(agent.name, allClaims, tasks);
      const computed = computeStatus(
        agent.activity?.lastActivityAt ?? agent.startedAt,
        hasTask,
        (agent.reservations?.length ?? 0) > 0,
        thresholdMs,
      );

      if (computed.status === "stuck") {
        currentlyStuck.add(agent.name);

        if (!notifiedStuck.has(agent.name)) {
          notifiedStuck.add(agent.name);
          logFeedEvent(ctx.cwd, agent.name, "stuck");

          const idleStr = computed.idleFor ?? "unknown";
          const taskInfo = hasTask ? " with task in progress" : " with reservation";
          ctx.ui.notify(
            `\u26A0\uFE0F ${agent.name} appears stuck (idle ${idleStr}${taskInfo})`,
            "warning",
          );
          if (config.stuckWakeAgent === state.agentName) {
            pi.sendMessage(
              {
                customType: "agent_stuck",
                content: `**Stuck peer detected: ${agent.name}**\n\nThe peer has been idle ${idleStr}${taskInfo}. Inspect the mesh and the peer's Herdr pane, then recover or reassign its work.`,
                display: true,
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          }
        }
      }
    }

    for (const name of notifiedStuck) {
      if (!currentlyStuck.has(name)) {
        notifiedStuck.delete(name);
      }
    }
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  function updateStatus(ctx: ExtensionContext): void {
    try {
      if (!ctx.hasUI || !state.registered) return;

      const agents = mesh.peers();
      checkStuckAgents(ctx, agents);
      const activeNames = new Set(agents.map((a) => a.name));
      const count = agents.length;
      const theme = ctx.ui.theme;

      for (const name of state.unreadCounts.keys()) {
        if (!activeNames.has(name)) {
          state.unreadCounts.delete(name);
        }
      }
      for (const name of notifiedStuck) {
        if (!activeNames.has(name)) {
          notifiedStuck.delete(name);
        }
      }

      // Sum remaining unread counts
      let totalUnread = 0;
      for (const n of state.unreadCounts.values()) totalUnread += n;

      const nameStr = theme.fg("accent", state.agentName);
      const countStr = theme.fg("dim", ` (${count} peer${count === 1 ? "" : "s"})`);
      const channelList = mesh.channels().join(",");
      const meshStr =
        mesh.kind === "mesh"
          ? theme.fg(
              mesh.status() === "connected" ? "dim" : "warning",
              mesh.status() === "connected"
                ? ` ⚡${channelList}`
                : mesh.status() === "reconnecting"
                  ? ` ⚡${channelList}…`
                  : ` ⚡${channelList}✗`,
            )
          : channelList !== "main"
            ? theme.fg("dim", ` #${channelList}`)
            : "";
      const unreadStr = totalUnread > 0 ? theme.fg("accent", ` ●${totalUnread}`) : "";

      const planningCwd = ctx.cwd;
      const planningStr = isPlanningForCwd(planningCwd)
        ? theme.fg(
            "warning",
            ` · plan ${planningState.pass}/${planningState.maxPasses} ${planningState.phase}${isPlanningStalled(planningCwd) ? " stalled" : ""}`,
          )
        : "";

      const activityStr =
        !planningStr && state.activity.currentActivity
          ? theme.fg("dim", ` · ${state.activity.currentActivity}`)
          : "";

      // Add crew status if autonomous mode is active
      let crewStr = "";
      if (autonomousState.active) {
        const cwd = ctx.cwd;
        const plan = crewStore.getPlan(cwd);
        if (plan) {
          const workerCount = getLiveWorkers(cwd).size;
          crewStr = theme.fg("accent", ` ⚡${plan.completed_count}/${plan.task_count}`);
          if (workerCount > 0) {
            crewStr += theme.fg("dim", ` 🔨${workerCount}`);
          }
        }
      }

      ctx.ui.setStatus(
        "messenger",
        `msg: ${nameStr}${countStr}${meshStr}${unreadStr}${planningStr}${activityStr}${crewStr}`,
      );

      maybeAutoOpenCrewOverlay(ctx);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("extension ctx is stale")) {
        throw error;
      }

      latestCtx = null;
      stopStatusHeartbeat();
    }
  }

  function clearAllUnreadCounts(): void {
    for (const key of state.unreadCounts.keys()) {
      state.unreadCounts.set(key, 0);
    }
  }

  const STATUS_HEARTBEAT_MS = 15_000;
  let latestCtx: ExtensionContext | null = null;
  let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const AUTONOMOUS_CONTINUE_REPEAT_LIMIT = 3;
  let autonomousContinueSignature: string | null = null;
  let autonomousContinueRepeats = 0;

  function resetAutonomousContinueGuard(): void {
    autonomousContinueSignature = null;
    autonomousContinueRepeats = 0;
  }

  function trackAutonomousContinue(signature: string): number {
    if (autonomousContinueSignature === signature) {
      autonomousContinueRepeats += 1;
    } else {
      autonomousContinueSignature = signature;
      autonomousContinueRepeats = 1;
    }
    return autonomousContinueRepeats;
  }

  function updateStatusFromBackground(): void {
    try {
      if (latestCtx) updateStatus(latestCtx);
    } catch (error) {
      console.error("omp-messenger background status update failed", error);
    }
  }

  function startStatusHeartbeat(): void {
    if (statusHeartbeatTimer) return;
    statusHeartbeatTimer = setInterval(() => {
      try {
        if (latestCtx) updateStatus(latestCtx);
      } catch (error) {
        console.error("omp-messenger status heartbeat failed", error);
      }
    }, STATUS_HEARTBEAT_MS);
  }

  function stopStatusHeartbeat(): void {
    if (!statusHeartbeatTimer) return;
    clearInterval(statusHeartbeatTimer);
    statusHeartbeatTimer = null;
  }

  function captureStatusContext(ctx: ExtensionContext): void {
    latestCtx = ctx;
    startStatusHeartbeat();
  }

  const unsubscribeLiveWorkers = onLiveWorkersChanged(() => {
    updateStatusFromBackground();
  });

  // ===========================================================================
  // Registration Context
  // ===========================================================================

  function sendRegistrationContext(ctx: ExtensionContext): void {
    const folder = extractFolder(ctx.cwd ?? state.cwd);
    const locationPart = state.gitBranch ? `${folder} on ${state.gitBranch}` : folder;
    pi.sendMessage(
      {
        customType: "messenger_context",
        content: `You are agent "${state.agentName}" in ${locationPart}. Use omp_messenger({ action: "status" }) to see crew status, omp_messenger({ action: "work" }) to run tasks.`,
        display: false,
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
  }

  // ===========================================================================
  // Tool Registration
  // ===========================================================================
  const teamToolDescription = loadCrewConfig(crewStore.getCrewDir(process.cwd())).team.enabled
    ? `

  // Team: Optional role-aware layer around Crew
  omp_messenger({ action: "team.setup", name: "migration-squad" }) → Activate profile, create starter charter, show next steps
  omp_messenger({ action: "team.profile.list" })                 → List built-in and saved team profiles
  omp_messenger({ action: "team.profile.use", name: "migration-squad" }) → Activate a team profile
  omp_messenger({ action: "team.charter.show" })                 → Show project team charter
  omp_messenger({ action: "team.memory.note", type: "decision", message: "..." })
  omp_messenger({ action: "team.roles" })                        → Resolve Team roles (packaged pi-subagents vocabulary + optional metadata)
  omp_messenger({ action: "team.status" })                       → Team summary`
    : "";

  pi.registerTool({
    name: "omp_messenger",
    label: "omp-messenger",
    loadMode: "essential",
    approval: (raw) => {
      const params = raw && typeof raw === "object" ? (raw as CrewParams) : {};
      const action = params.action ?? "status";
      if (
        [
          "status",
          "channels",
          "list",
          "whois",
          "feed",
          "swarm",
          "task.show",
          "task.list",
          "team.profile.list",
          "team.charter.show",
          "team.roles",
          "team.status",
          "crew.status",
          "crew.agents",
        ].includes(action) ||
        (action === "autoRegisterPath" && params.autoRegisterPath === "list")
      )
        return "read";
      if (["plan", "work", "review", "sync", "task.revise", "task.revise-tree"].includes(action))
        return "exec";
      return "write";
    },
    description: `Multi-agent coordination and task orchestration.

Usage (action-based API - preferred):
  // Coordination
  omp_messenger({ action: "join", channels: ["main", "repo-a"] }) → Join mesh channels (channels is optional)
  omp_messenger({ action: "channels" })                          → List mesh channels
  omp_messenger({ action: "channels.join", channels: ["blue"] }) → Join additional channels
  omp_messenger({ action: "channels.leave", channels: ["blue"] })→ Leave channels (last one leaves the mesh)
  omp_messenger({ action: "channels.delete", channel: "test" }) → Delete a channel and its history; notify members. WebSocket only. main is protected.
  omp_messenger({ action: "leave" })                             → Leave mesh for this session
  omp_messenger({ action: "status" })                            → Get status
  omp_messenger({ action: "list" })                              → List agents with presence
  omp_messenger({ action: "feed", limit: 20 })                   → Activity feed
  omp_messenger({ action: "whois", name: "AgentName" })          → Agent details
  omp_messenger({ action: "set_status", message: "reviewing" })  → Set custom status
  omp_messenger({ action: "reserve", paths: ["src/"] })          → Reserve files
  omp_messenger({ action: "send", to: "Agent", message: "hi" })  → Direct message
  omp_messenger({ action: "broadcast", channel: "main", message: "@Storm take the parser" })
                                                                  → Post to a channel's group chat: @name / @all
                                                                    interrupt those members, the rest read it quietly
  
  // Crew: Plan from PRD
  omp_messenger({ action: "plan" })                              → Auto-discover PRD
  omp_messenger({ action: "plan", prd: "docs/PRD.md" })          → Explicit PRD path
  omp_messenger({ action: "plan", prompt: "Scan for bugs" })     → Inline prompt (no PRD)
  omp_messenger({ action: "plan.cancel" })                       → Cancel active planning
  
  // Crew: Work through tasks
  omp_messenger({ action: "work" })                              → Run ready tasks
  omp_messenger({ action: "work", autonomous: true })            → Run until done/blocked
  omp_messenger({ action: "work.stop" })                         → Stop autonomous work for this project
  
  // Crew: Tasks
  omp_messenger({ action: "task.show", id: "task-1" })           → Show task
  omp_messenger({ action: "task.list" })                         → List all tasks
  omp_messenger({ action: "task.split", id: "task-3" })          → Inspect task for splitting
  omp_messenger({ action: "task.split", id: "task-3", subtasks: [...] }) → Execute split
  omp_messenger({ action: "task.start", id: "task-1" })          → Start task
  omp_messenger({ action: "task.approve", id: "task-1" })        → Approve gated task
  omp_messenger({ action: "task.reject", id: "task-1", reason: "..." }) → Reject gated task and feed revision
  omp_messenger({ action: "task.done", id: "task-1", summary: "..." })
  omp_messenger({ action: "task.reset", id: "task-1" })          → Reset task
  
  // Crew: Review
  omp_messenger({ action: "review", target: "task-1" })          → Review impl${teamToolDescription}`,
    parameters: z
      .object({
        action: z
          .string()
          .describe("Action to perform (e.g., 'join', 'plan', 'work', 'task.start')")
          .optional(),
        prd: z.string().describe("PRD file path for plan action").optional(),
        prompt: z
          .string()
          .describe(
            "Inline prompt for plan action, or revision instructions for task.revise/task.revise-tree",
          )
          .optional(),
        id: z.string().describe("Task ID (task-N format)").optional(),
        taskId: z
          .string()
          .describe("Swarm task ID (e.g., TASK-01) - for action-based claim/unclaim/complete")
          .optional(),
        title: z.string().describe("Title for task.create").optional(),
        dependsOn: z
          .array(z.string())
          .describe("Task IDs this task depends on (for task.create)")
          .optional(),
        role: z
          .string()
          .describe(
            "Team role for task creation/planning (built-ins follow packaged pi-subagents vocabulary; profiles may define more)",
          )
          .optional(),
        riskLabels: z.array(z.string()).describe("Team risk labels for approval policy").optional(),
        target: z.string().describe("Task ID for review action").optional(),
        summary: z.string().describe("Summary for task.done").optional(),
        evidence: z
          .object({
            commits: z.array(z.string()).optional(),
            tests: z.array(z.string()).optional(),
            prs: z.array(z.string()).optional(),
          })
          .passthrough()
          .describe("Evidence for task.done")
          .optional(),
        content: z.string().describe("Content for task spec").optional(),
        count: z.number().describe("Suggested number of subtasks for task.split").optional(),
        subtasks: z
          .array(
            z
              .object({
                title: z.string(),
                content: z.string().optional(),
              })
              .passthrough(),
          )
          .describe("Subtask definitions for task.split (execute phase)")
          .optional(),
        type: z
          .enum(["plan", "impl", "decision", "interface", "risk", "handoff"])
          .describe("Review type, or Team memory type for team.memory.*")
          .optional(),
        autoWork: z
          .boolean()
          .describe(
            "Auto-start autonomous work after plan completes (default: true, pass false to review plan first)",
          )
          .optional(),
        autonomous: z.boolean().describe("Run work continuously until done/blocked").optional(),
        concurrency: z.number().describe("Override worker concurrency").optional(),
        cascade: z.boolean().describe("For task.reset - also reset dependent tasks").optional(),
        limit: z
          .number()
          .describe("Number of events to return (for feed action, default 20)")
          .optional(),
        paths: z.array(z.string()).describe("Paths for reserve/release actions").optional(),
        name: z
          .string()
          .describe("Name for rename action or Team setup/profile/charter commands")
          .optional(),
        channel: z
          .string()
          .describe(
            "Channel for send/claim routing or channels.delete. Deletion removes history and notifies members; main is protected.",
          )
          .optional(),
        channels: z
          .array(z.string())
          .describe("Mesh channels for join / channels.join / channels.leave")
          .optional(),
        spec: z.string().describe("Path to spec/plan file").optional(),
        notes: z.string().describe("Completion notes").optional(),
        to: z.any().describe("Target agent name (string) or multiple names (array)").optional(),
        message: z
          .string()
          .describe("Message to send, Team setup/charter text, or Team memory note")
          .optional(),
        replyTo: z.string().describe("Message ID if this is a reply").optional(),
        gentle: z
          .boolean()
          .describe(
            "Deliver without interrupting the recipient (queued until its current step ends). Default: interrupt.",
          )
          .optional(),
        reason: z
          .string()
          .describe("Reason for reservation, claim, task block, or approval rejection feedback")
          .optional(),
        autoRegisterPath: z
          .enum(["add", "remove", "list"])
          .describe("Manage auto-register paths: add/remove current folder, or list all")
          .optional(),
      })
      .passthrough(),

    // Peer traffic renders in the same visual language as omp's hub cards (IRC ➤ out /
    // ⟵ in): status header with icon + accent title + dim meta, quoted body with a dim
    // border glyph. `mergeCallAndResult` makes the completed result frame REPLACE the
    // pending call frame, so the body shows exactly once. The flag is absent from
    // ToolDefinition's type, but the TUI reads it off the tool object and the extension
    // tool proxy (applyToolProxy) forwards own properties, so attach it structurally.
    ...({ mergeCallAndResult: true } as object),
    describeCall(args) {
      const call = args as CrewParams;
      const body = call.message ? [nativeText(call.message)] : undefined;
      return { tool: { title: actionTitle(call), meta: actionMeta(call) }, body };
    },
    describeResult(result, _options, args) {
      const call = args as CrewParams | undefined;
      const output = result.content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join("\n")
        .trim();
      return {
        tool: { title: actionTitle(call), meta: actionMeta(call) },
        tone: result.isError ? "error" : undefined,
        body: output ? [nativeText(output)] : undefined,
      };
    },
    renderCall(args, _options, theme) {
      const call = args as CrewParams;
      if (call.action === "send" || call.action === "broadcast") {
        const lines = [
          statusLine(
            { icon: "pending", title: `IRC ${theme.nav.selected} ${hubTarget(call)}` },
            theme,
          ),
        ];
        const preview = call.message?.replace(/\s+/g, " ").trim();
        if (preview) lines.push(theme.fg("dim", `  │ ${preview}`));
        return statusCard(lines);
      }
      return statusCard([
        statusLine({ icon: "pending", title: actionTitle(call), meta: actionMeta(call) }, theme),
      ]);
    },
    renderResult(result, options, theme, args) {
      const call = args as CrewParams | undefined;
      if (call && (call.action === "send" || call.action === "broadcast")) {
        const details = result.details && typeof result.details === "object" ? result.details : {};
        const sent =
          "sent" in details && Array.isArray(details.sent)
            ? details.sent.filter((s): s is string => typeof s === "string")
            : [];
        const failed =
          "failed" in details && Array.isArray(details.failed)
            ? details.failed.filter(
                (f): f is { name: string; error: string } =>
                  typeof f === "object" &&
                  f !== null &&
                  typeof (f as { name?: unknown }).name === "string",
              )
            : [];
        const isBroadcast = call.action === "broadcast" || sent.length + failed.length > 1;
        const isError = result.isError === true || (sent.length === 0 && failed.length > 0);
        const meta: string[] = [];
        if (isBroadcast) {
          if (sent.length > 0) meta.push(theme.fg("success", `${sent.length} delivered`));
          if (failed.length > 0) meta.push(theme.fg("error", `${failed.length} failed`));
        } else if (sent.length === 1) {
          meta.push(theme.fg("success", "delivered"));
        }
        if (call.channel) meta.push(`#${call.channel}`);
        const glyph = isError
          ? theme.fg("error", theme.status.error)
          : theme.styledSymbol("tool.irc", "accent");
        const lines = [
          statusLine({ glyph, title: `IRC ${theme.nav.selected} ${hubTarget(call)}`, meta }, theme),
        ];
        if (isError) {
          const reason =
            failed[0]?.error ??
            result.content
              .map((c) => (c.type === "text" ? c.text : ""))
              .join(" ")
              .trim() ??
            "send failed";
          lines.push(theme.fg("error", `  ✗ ${reason}`));
        } else if (call.message) {
          lines.push(
            ...ircQuoteBody(call.message, theme, options.expanded ? Number.MAX_SAFE_INTEGER : 3),
          );
        }
        return statusCard(lines);
      }
      const isError = result.isError === true;
      const firstLine =
        result.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("")
          .trim()
          .split("\n")[0] ?? "";
      const lines = [
        statusLine(
          { icon: isError ? "error" : "success", title: actionTitle(call), meta: actionMeta(call) },
          theme,
        ),
      ];
      if (firstLine)
        lines.push(`  ${isError ? theme.fg("error", firstLine) : theme.fg("muted", firstLine)}`);
      return statusCard(lines);
    },

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as CrewParams;
      if (params.model !== undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Per-call model overrides are unavailable; omit model to use configured agent routing.",
            },
          ],
          details: { error: "per_call_model_unsupported" },
          isError: true,
        };
      }
      captureStatusContext(ctx);

      const action = params.action;
      if (
        (ctx.agent?.kind === "sub" || state.isCrewWorker) &&
        (action === "work.stop" ||
          (action === "work" && params.autonomous) ||
          action === "plan.cancel")
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Autonomous and planning lifecycle controls belong to the main session.",
            },
          ],
          details: { error: "main_session_required" },
          isError: true,
        };
      }
      if (!action) {
        return handlers.executeStatus(state, mesh, ctx.cwd);
      }
      if (
        ctx.agent?.kind !== "sub" &&
        !state.isCrewWorker &&
        ((action === "plan" && !isPlanningForCwd(ctx.cwd)) ||
          (action === "work" && params.autonomous && !isAutonomousForCwd(ctx.cwd)))
      ) {
        ownsCrewLifecycle = true;
      }

      const result = await executeCrewAction(
        action,
        params,
        state,
        mesh,
        ctx,
        deliverMessage,
        (currentCtx) => {
          if (action === "plan" && ownsCrewLifecycle && isPlanningForCwd(currentCtx.cwd)) {
            ownedPlanningRunId = planningState.runId;
          }
          updateStatus(currentCtx);
        },
        (type, data) => pi.appendEntry(type, data),
        {
          stuckThreshold: config.stuckThreshold,
          crewEventsInFeed: config.crewEventsInFeed,
          nameTheme,
          feedRetention: config.feedRetention,
          ownerSignal: ownedWorkAbort.signal,
        },
        signal,
      );

      if (action === "join" && state.registered && config.registrationContext) {
        sendRegistrationContext(ctx);
      }

      if (action === "leave" && !state.registered) {
        overlayHandle?.hide();
        overlayHandle = null;
        overlayTui = null;
        overlayOpening = false;
      }

      return result;
    },
  });

  // ===========================================================================
  // Commands
  // ===========================================================================

  /** Rebuild the mesh from freshly loaded config; rejoin if this session was joined. */
  async function applyMeshSettings(ctx: ExtensionContext): Promise<void> {
    config = loadConfig(state.cwd);
    const wasRegistered = state.registered;
    if (wasRegistered) {
      try {
        await mesh.leave();
      } catch {}
    }
    mesh.close();
    state.channels = config.mesh.channels;
    mesh = createMesh({
      config,
      base: baseDir,
      state,
      deliver: deliverMessage,
      onStatusChange: () => {
        updateStatusFromBackground();
      },
    });
    if (wasRegistered) {
      if (await mesh.join(ctx, { nameTheme })) {
        ctx.ui.notify(
          `Rejoined mesh as ${state.agentName} (${mesh.kind === "mesh" ? config.mesh.url : "local"}, #${mesh.channels().join(",")})`,
          "info",
        );
      } else {
        ctx.ui.notify("Mesh settings saved, but rejoining failed — check URL/token", "error");
      }
    }
    updateStatus(ctx);
  }

  async function openConfigOverlay(ctx: ExtensionContext): Promise<void> {
    let pending: Promise<void> | null = null;
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        return new MessengerConfigOverlay(tui, theme, done, ctx.cwd, {
          onMeshSettingsSaved: () => {
            pending = applyMeshSettings(ctx);
          },
        });
      },
      { overlay: true },
    );
    if (pending) await pending;
  }

  pi.registerCommand("messenger", {
    description: "Open messenger overlay, or 'config' to manage mesh settings",
    handler: async (args, ctx) => {
      if (ctx.agent?.kind === "sub" || state.isCrewWorker) return;
      captureStatusContext(ctx);
      if (!ctx.hasUI) return;

      if (args.trim().split(/\s+/, 1)[0] === "config") {
        await openConfigOverlay(ctx);
        return;
      }

      // /messenger - open chat overlay (auto-joins if not registered)
      if (!state.registered) {
        if (!(await mesh.join(ctx, { nameTheme }))) {
          ctx.ui.notify(
            "Failed to join agent mesh — press c in /messenger or run /messenger config",
            "error",
          );
          await openConfigOverlay(ctx);
          return;
        }
        updateStatus(ctx);
      }

      if (overlayHandle && overlayHandle.isHidden()) {
        overlayHandle.setHidden(false);
        clearAllUnreadCounts();
        updateStatus(ctx);
        return;
      }

      const openingEpoch = overlayEpoch;
      let openConfigAfter = false;
      const callbacks: OverlayCallbacks = {
        onBackground: (snapshotText) => {
          if (openingEpoch !== overlayEpoch) return;
          overlayHandle?.setHidden(true);
          pi.sendMessage(
            {
              customType: "crew_snapshot",
              content: snapshotText,
              display: true,
            },
            { triggerTurn: true },
          );
        },
        onOpenConfig: () => {
          openConfigAfter = true;
        },
      };

      const snapshot = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(
            tui,
            theme,
            state,
            mesh,
            done,
            callbacks,
            ctx.cwd,
            ctx.agent?.id,
            ctx.sessionManager.getSessionId(),
            ownedWorkAbort.signal,
          );
        },
        {
          overlay: true,
          onHandle: (handle) => {
            if (openingEpoch === overlayEpoch) overlayHandle = handle;
            else handle.hide();
          },
        },
      );
      if (openingEpoch !== overlayEpoch) return;

      if (snapshot) {
        pi.sendMessage(
          {
            customType: "crew_snapshot",
            content: snapshot,
            display: true,
          },
          { triggerTurn: true },
        );
      }

      // Overlay closed
      clearAllUnreadCounts();
      overlayHandle = null;
      overlayTui = null;
      updateStatus(ctx);

      if (openConfigAfter) {
        await openConfigOverlay(ctx);
      }
    },
  });

  // ===========================================================================
  // Message Renderer
  // ===========================================================================

  // ===========================================================================
  // Activity Tracking
  // ===========================================================================

  const EDIT_DEBOUNCE_MS = 5000;
  const REGISTRY_FLUSH_MS = 10000;
  const RECENT_WINDOW_MS = 60_000;
  const pendingEdits = new Map<string, ReturnType<typeof setTimeout>>();
  let recentCommit = false;
  let recentCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let recentTestRuns = 0;
  let recentTestTimer: ReturnType<typeof setTimeout> | null = null;
  let recentEdits = 0;
  let recentEditTimer: ReturnType<typeof setTimeout> | null = null;

  function updateLastActivity(): void {
    state.activity.lastActivityAt = new Date().toISOString();
  }

  function incrementToolCount(): void {
    state.session.toolCalls++;
  }

  function setCurrentActivity(activity: string): void {
    state.activity.currentActivity = activity;
  }

  function clearCurrentActivity(): void {
    state.activity.currentActivity = undefined;
  }

  function setLastToolCall(toolCall: string): void {
    state.activity.lastToolCall = toolCall;
  }

  function addModifiedFile(filePath: string): void {
    const files = state.session.filesModified;
    const idx = files.indexOf(filePath);
    if (idx !== -1) files.splice(idx, 1);
    files.push(filePath);
    if (files.length > 20) files.shift();
  }

  function debouncedLogEdit(filePath: string, cwd: string): void {
    const existing = pendingEdits.get(filePath);
    if (existing) clearTimeout(existing);
    pendingEdits.set(
      filePath,
      setTimeout(() => {
        try {
          logFeedEvent(cwd, state.agentName, "edit", filePath);
        } catch (error) {
          console.error("omp-messenger edit activity failed", error);
        } finally {
          pendingEdits.delete(filePath);
        }
      }, EDIT_DEBOUNCE_MS),
    );
  }

  function scheduleRegistryFlush(ctx: ExtensionContext): void {
    if (state.registryFlushTimer) return;
    state.registryFlushTimer = setTimeout(() => {
      state.registryFlushTimer = null;
      try {
        mesh.publish(latestCtx ?? ctx);
      } catch (error) {
        console.error("omp-messenger registry update failed", error);
      }
    }, REGISTRY_FLUSH_MS);
  }

  function isGitCommit(command: string): boolean {
    return /\bgit\s+commit\b/.test(command);
  }

  function isTestRun(command: string): boolean {
    return /\b(npm\s+test|npx\s+(jest|vitest|mocha)|pytest|go\s+test|cargo\s+test|bun\s+test)\b/.test(
      command,
    );
  }

  function extractCommitMessage(command: string): string {
    const match = command.match(/-m\s+["']([^"']+)["']/);
    return match ? match[1] : "";
  }

  function updateAutoStatus(): void {
    if (!state.registered || !config.autoStatus || state.customStatus) return;

    const autoMsg = generateAutoStatus({
      currentActivity: state.activity.currentActivity,
      recentCommit,
      recentTestRuns,
      recentEdits,
      sessionStartedAt: state.sessionStartedAt,
    });

    state.statusMessage = autoMsg;
  }

  function trackRecentCommit(): void {
    recentCommit = true;
    if (recentCommitTimer) clearTimeout(recentCommitTimer);
    recentCommitTimer = setTimeout(() => {
      recentCommit = false;
    }, RECENT_WINDOW_MS);
  }

  function trackRecentTest(): void {
    recentTestRuns++;
    if (recentTestTimer) clearTimeout(recentTestTimer);
    recentTestTimer = setTimeout(() => {
      recentTestRuns = 0;
    }, RECENT_WINDOW_MS);
  }

  function trackRecentEdit(): void {
    recentEdits++;
    if (recentEditTimer) clearTimeout(recentEditTimer);
    recentEditTimer = setTimeout(() => {
      recentEdits = 0;
    }, RECENT_WINDOW_MS);
  }

  function shortenPath(filePath: string): string {
    const parts = filePath.split("/");
    return parts.length > 2 ? parts.slice(-2).join("/") : filePath;
  }

  async function writeTargets(toolName: string, input: Record<string, unknown>): Promise<string[]> {
    const targets: string[] = [];
    if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") {
      targets.push(unwrapEditHeaderPath(input.path));
    }
    if (toolName === "ast_edit" && Array.isArray(input.paths)) {
      targets.push(
        ...input.paths.flatMap((path: unknown) =>
          typeof path === "string"
            ? path
                .split(";")
                .map((part) => part.trim())
                .filter(Boolean)
            : [],
        ),
      );
    }
    if ((toolName === "edit" || toolName === "apply_patch") && typeof input.input === "string") {
      const mode = /^\*\*\* Edit File:/m.test(input.input)
        ? "sloppy"
        : /^\[[^\r\n]+#[0-9A-Fa-f]{4}\]\s*$/m.test(input.input)
          ? "hashline"
          : "apply_patch";
      targets.push(...freeformEditTargets(input.input, mode));
    }
    return [...new Set(targets)];
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!state.registered) return;

    updateLastActivity();
    incrementToolCount();
    scheduleRegistryFlush(ctx);

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (["write", "edit", "apply_patch", "ast_edit"].includes(toolName)) {
      const paths = await writeTargets(toolName, input);
      if (paths.length) setCurrentActivity(`editing ${shortenPath(paths[0])}`);
      for (const path of paths) {
        debouncedLogEdit(path, ctx.cwd);
        trackRecentEdit();
      }
    } else if (toolName === "read") {
      const path = input.path as string;
      if (path) {
        setCurrentActivity(`reading ${shortenPath(path)}`);
      }
    } else if (toolName === "bash") {
      const command = input.command as string;
      if (command) {
        if (isGitCommit(command)) {
          setCurrentActivity("committing");
        } else if (isTestRun(command)) {
          setCurrentActivity("running tests");
        }
      }
    }

    updateAutoStatus();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!state.registered) return;

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (!event.isError && ["write", "edit", "apply_patch", "ast_edit"].includes(toolName)) {
      for (const path of await writeTargets(toolName, input)) {
        setLastToolCall(`${toolName}: ${shortenPath(path)}`);
        addModifiedFile(path);
      }
    }

    if (toolName === "bash") {
      const command = input.command as string;
      if (command) {
        const cwd = ctx.cwd;
        if (isGitCommit(command)) {
          const msg = extractCommitMessage(command);
          logFeedEvent(cwd, state.agentName, "commit", undefined, msg);
          setLastToolCall(`commit: ${msg}`);
          trackRecentCommit();
        }
        if (isTestRun(command)) {
          const passed = !event.isError;
          logFeedEvent(cwd, state.agentName, "test", undefined, passed ? "passed" : "failed");
          setLastToolCall(`test: ${passed ? "passed" : "failed"}`);
          trackRecentTest();
        }
      }
    }

    clearCurrentActivity();
    updateAutoStatus();
    scheduleRegistryFlush(ctx);
  });

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    ownerSessionId = ctx.sessionManager?.getSessionId?.();
    captureStatusContext(ctx);
    state.cwd = ctx.cwd;
    config = loadConfig(state.cwd);
    state.channels = config.mesh.channels;
    const identity = detectCrewIdentity(ctx);
    if (identity) {
      state.agentName = identity.name;
      state.explicitName = true;
      state.isCrewWorker = true;
    }
    if (!state.registered) {
      mesh.close();
      mesh = createMesh({
        config,
        base: baseDir,
        state,
        deliver: deliverMessage,
        onStatusChange: () => {
          updateStatusFromBackground();
        },
      });
    }
    state.scopeToFolder = config.scopeToFolder;
    nameTheme.theme = config.nameTheme;
    nameTheme.customWords = config.nameWords;
    if (ctx.agent?.kind !== "sub" && !state.isCrewWorker) {
      resetAutonomousContinueGuard();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "crew-state") {
          restoreAutonomousState(entry.data as Parameters<typeof restoreAutonomousState>[0]);
          ownsCrewLifecycle = isAutonomousForCwd(ctx.cwd);
        }
      }
      const { staleCleared } = restorePlanningState(state.cwd);
      if (staleCleared && ctx.hasUI) {
        ctx.ui.notify("Stale planning state cleared (planner process exited)", "warning");
      }
    }
    startStatusHeartbeat();

    state.isHuman = ctx.hasUI;

    const shouldAutoRegister =
      state.isCrewWorker ||
      config.autoRegister ||
      matchesAutoRegisterPath(state.cwd, config.autoRegisterPaths);

    if (!shouldAutoRegister) {
      maybeAutoOpenCrewOverlay(ctx);
      return;
    }

    if (await mesh.join(ctx, { nameTheme })) {
      const cwd = state.cwd;
      updateStatus(ctx);
      pruneFeed(cwd, config.feedRetention);
      logFeedEvent(cwd, state.agentName, "join");

      if (config.registrationContext) {
        sendRegistrationContext(ctx);
      }
    }

    maybeAutoOpenCrewOverlay(ctx);
  });

  function maybeAutoOpenCrewOverlay(ctx: ExtensionContext): void {
    if (ctx.agent?.kind === "sub" || state.isCrewWorker) return;
    const cwd = ctx.cwd;
    if (config.autoOverlayPlanning) {
      markPlanningOverlayPending(cwd);
    }

    const autonomousPending =
      config.autoOverlay && autonomousState.active && autonomousState.autoOverlayPending;

    const planningPending = config.autoOverlayPlanning ? getPlanningOverlayPending(cwd) : null;

    if ((!autonomousPending && !planningPending) || !ctx.hasUI || overlayTui || overlayOpening) {
      return;
    }

    if (autonomousPending) {
      autonomousState.autoOverlayPending = false;
    }

    const planningRunId = planningPending
      ? (consumePlanningOverlayPending(cwd)?.runId ?? null)
      : null;

    overlayOpening = true;
    const openingEpoch = overlayEpoch;
    const callbacks: OverlayCallbacks = {
      onBackground: (snapshotText) => {
        if (openingEpoch !== overlayEpoch) return;
        overlayHandle?.setHidden(true);
        pi.sendMessage(
          {
            customType: "crew_snapshot",
            content: snapshotText,
            display: true,
          },
          { triggerTurn: true },
        );
      },
    };

    ctx.ui
      .custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(
            tui,
            theme,
            state,
            mesh,
            done,
            callbacks,
            ctx.cwd,
            ctx.agent?.id,
            ctx.sessionManager.getSessionId(),
            ownedWorkAbort.signal,
          );
        },
        {
          overlay: true,
          onHandle: (handle) => {
            if (openingEpoch === overlayEpoch) overlayHandle = handle;
            else handle.hide();
          },
        },
      )
      .then((snapshot) => {
        if (openingEpoch !== overlayEpoch) return;
        if (planningRunId) {
          dismissPlanningOverlayRun(planningRunId);
        }
        if (snapshot) {
          pi.sendMessage(
            {
              customType: "crew_snapshot",
              content: snapshot,
              display: true,
            },
            { triggerTurn: true },
          );
        }
        clearAllUnreadCounts();
        overlayOpening = false;
        overlayHandle = null;
        overlayTui = null;
        updateStatus(ctx);
      })
      .catch(() => {
        if (openingEpoch !== overlayEpoch) return;
        overlayOpening = false;
        overlayHandle = null;
        overlayTui = null;
        if (config.autoOverlayPlanning) {
          markPlanningOverlayPending(cwd);
        }
      });
  }

  function onSessionReplacement(ctx: ExtensionContext): void {
    captureStatusContext(ctx);
    if (ctx.agent?.kind === "sub" || state.isCrewWorker) return;
    ownedWorkAbort.abort();
    if (ownerSessionId && state.cwd) {
      shutdownLobbyWorkers(state.cwd, ownerSessionId);
      shutdownAllWorkers(state.cwd, ownerSessionId);
    }
    if (
      ownedPlanningRunId &&
      planningState.runId === ownedPlanningRunId &&
      isPlanningForCwd(state.cwd)
    ) {
      cancelPlanningRun(state.cwd);
    }
    ownedPlanningRunId = null;
    if (ownsCrewLifecycle) {
      if (isAutonomousForCwd(state.cwd)) stopAutonomous("manual");
      consumePendingAutoWork(state.cwd);
      ownsCrewLifecycle = false;
    }
    resetAutonomousContinueGuard();
    overlayEpoch++;
    overlayHandle?.hide();
    overlayHandle = null;
    overlayTui = null;
    overlayOpening = false;
    if (state.registryFlushTimer) {
      clearTimeout(state.registryFlushTimer);
      state.registryFlushTimer = null;
    }
    ownerSessionId = ctx.sessionManager?.getSessionId?.();
    ownedWorkAbort = new AbortController();
    state.cwd = ctx.cwd;
    if (state.registered) mesh.publish(ctx);
    updateStatus(ctx);
  }

  pi.on("session_switch", async (_event, ctx) => onSessionReplacement(ctx));
  pi.on("session_branch", async (_event, ctx) => onSessionReplacement(ctx));

  pi.on("session_tree", async (_event, ctx) => {
    captureStatusContext(ctx);
    if (ctx.agent?.kind === "sub" || state.isCrewWorker) return;
    const { staleCleared } = restorePlanningState(ctx.cwd);
    if (staleCleared && ctx.hasUI) {
      ctx.ui.notify("Stale planning state cleared (planner process exited)", "warning");
    }
    updateStatus(ctx);
    maybeAutoOpenCrewOverlay(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    captureStatusContext(ctx);
    mesh.drainInbox();
    mesh.recoverInbox();
    updateStatus(ctx);

    if (state.registered) {
      const msg = event.message as unknown as Record<string, unknown> | undefined;
      if (msg && msg.role === "assistant" && msg.usage) {
        const usage = msg.usage as { totalTokens?: number; input?: number; output?: number };
        const total = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
        if (total > 0) {
          state.session.tokens += total;
          scheduleRegistryFlush(ctx);
        }
      }
    }

    maybeAutoOpenCrewOverlay(ctx);
  });

  // ===========================================================================
  // Crew Autonomous Mode Continuation
  // ===========================================================================

  pi.on("agent_end", async (event, ctx) => {
    if (
      event.willContinue ||
      event.awaitingAsyncWork ||
      ctx.agent?.kind === "sub" ||
      state.isCrewWorker
    ) {
      return;
    }

    if (!state.registered) {
      if (isAutonomousForCwd(ctx.cwd)) {
        stopAutonomous("manual");
        pi.appendEntry("crew-state", autonomousState);
        resetAutonomousContinueGuard();
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Autonomous stopped: this session is not registered in omp-messenger.",
            "warning",
          );
        }
      }
      return;
    }

    // --- Auto-work after plan completion ---
    const autoWork = overlayTui ? null : consumePendingAutoWork(ctx.cwd);
    if (autoWork) {
      const cwd = autoWork.cwd;
      const crewConfig = loadCrewConfig(crewStore.getCrewDir(cwd));
      const readyTasks = crewStore.getReadyTasks(cwd, {
        advisory: crewConfig.dependencies === "advisory",
      });
      const startableTasks = readyTasks.filter((t) => !teamStore.taskNeedsApproval(cwd, t));
      if (startableTasks.length > 0) {
        const plan = crewStore.getPlan(cwd);
        const label = plan ? crewStore.getPlanLabel(plan) : "plan";
        pi.sendMessage(
          {
            customType: "crew_auto_work",
            content: `Plan complete — ${startableTasks.length} task(s) ready for ${label}. Starting autonomous work.\n\nCall: omp_messenger({ action: "work", autonomous: true })`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
        return;
      }
      if (readyTasks.length > 0) {
        const rejected = readyTasks.filter((t) => teamStore.taskNeedsRevision(cwd, t));
        const pending = readyTasks.filter((t) => teamStore.taskPendingApproval(cwd, t));
        pi.sendMessage({
          customType:
            rejected.length > 0 ? "crew_auto_work_needs_revision" : "crew_auto_work_needs_approval",
          content:
            rejected.length > 0
              ? `Plan complete — ${rejected.length} ready task(s) need revision before autonomous work can start.`
              : `Plan complete — ${pending.length} ready task(s) need lead approval before autonomous work can start.`,
          display: true,
        });
        return;
      }
    }

    // --- Existing autonomous continuation ---
    if (!autonomousState.active) {
      resetAutonomousContinueGuard();
      return;
    }

    const currentCwd = ctx.cwd;
    if (!isAutonomousForCwd(currentCwd)) {
      resetAutonomousContinueGuard();
      return;
    }

    const cwd = autonomousState.cwd ?? currentCwd;
    const crewDir = join(cwd, ".omp", "messenger", "crew");
    const crewConfig = loadCrewConfig(crewDir);

    // Check max waves limit
    if (autonomousState.waveNumber >= crewConfig.work.maxWaves) {
      stopAutonomous("manual");
      pi.appendEntry("crew-state", autonomousState);
      resetAutonomousContinueGuard();
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Autonomous stopped: max waves (${crewConfig.work.maxWaves}) reached`,
          "warning",
        );
      }
      return;
    }

    // Check for ready tasks
    const readyTasks = crewStore.getReadyTasks(cwd, {
      advisory: crewConfig.dependencies === "advisory",
    });
    const startableTasks = readyTasks.filter((t) => !teamStore.taskNeedsApproval(cwd, t));

    if (startableTasks.length === 0) {
      // No ready tasks - check if all done or blocked
      const allTasks = crewStore.getTasks(cwd);
      const allDone = allTasks.every((t) => t.status === "done");
      const needsApproval = readyTasks.filter((t) => teamStore.taskPendingApproval(cwd, t));
      const rejected = readyTasks.filter((t) => teamStore.taskNeedsRevision(cwd, t));

      stopAutonomous(allDone ? "completed" : "blocked");

      const plan = crewStore.getPlan(cwd);
      if (ctx.hasUI) {
        if (allDone) {
          ctx.ui.notify(`✅ All tasks complete for ${plan?.prd ?? "plan"}!`, "info");
        } else if (rejected.length > 0) {
          ctx.ui.notify(`Autonomous stopped: ${rejected.length} task(s) need revision`, "warning");
        } else if (needsApproval.length > 0) {
          ctx.ui.notify(
            `Autonomous stopped: ${needsApproval.length} task(s) need lead approval`,
            "warning",
          );
        } else {
          const blocked = allTasks.filter((t) => t.status === "blocked");
          ctx.ui.notify(`Autonomous stopped: ${blocked.length} task(s) blocked`, "warning");
        }
      }
      return;
    }

    const continueSignature = `${cwd}:${autonomousState.waveNumber}:${startableTasks
      .map((task) => task.id)
      .sort()
      .join(",")}`;
    const continueRepeatCount = trackAutonomousContinue(continueSignature);
    if (continueRepeatCount >= AUTONOMOUS_CONTINUE_REPEAT_LIMIT) {
      stopAutonomous("manual");
      pi.appendEntry("crew-state", autonomousState);
      resetAutonomousContinueGuard();

      const plan = crewStore.getPlan(cwd);
      const message = `Autonomous work on ${plan?.prd ?? "plan"} stopped after ${continueRepeatCount} repeated continuation retries without wave progress. Resolve the abort condition, then run omp_messenger({ action: "work", autonomous: true }).`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
      pi.sendMessage({
        customType: "crew_continue_stopped",
        content: message,
        display: true,
      });
      return;
    }

    // Continue to next wave
    // Note: waveNumber was already incremented by addWaveResult() in work.ts
    const plan = crewStore.getPlan(cwd);
    pi.sendMessage(
      {
        customType: "crew_continue",
        content: `Continuing autonomous work on ${plan?.prd ?? "plan"}. Wave ${autonomousState.waveNumber} with ${startableTasks.length} ready task(s).`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );

    // The steer message will trigger the LLM to call work again
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    latestCtx = null;
    const cwd = ctx.cwd || state.cwd;
    if (ctx.agent?.kind !== "sub" && !state.isCrewWorker && cwd) {
      ownedWorkAbort.abort();
      const sessionId = ctx.sessionManager.getSessionId();
      shutdownLobbyWorkers(cwd, sessionId);
      shutdownAllWorkers(cwd, sessionId);
    }
    stopStatusHeartbeat();
    unsubscribeLiveWorkers();
    overlayEpoch++;
    overlayOpening = false;
    overlayHandle = null;
    overlayTui = null;
    if (
      ctx.agent?.kind !== "sub" &&
      !state.isCrewWorker &&
      ownsCrewLifecycle &&
      cwd &&
      isPlanningForCwd(cwd) &&
      ownedPlanningRunId !== null &&
      planningState.runId === ownedPlanningRunId
    ) {
      cancelPlanningRun(cwd);
      ownedPlanningRunId = null;
    }
    if (cwd && state.registered) {
      logFeedEvent(cwd, state.agentName, "leave");
    }
    if (state.registryFlushTimer) {
      clearTimeout(state.registryFlushTimer);
      state.registryFlushTimer = null;
    }
    for (const timer of pendingEdits.values()) {
      clearTimeout(timer);
    }
    pendingEdits.clear();
    if (recentCommitTimer) {
      clearTimeout(recentCommitTimer);
      recentCommitTimer = null;
    }
    if (recentTestTimer) {
      clearTimeout(recentTestTimer);
      recentTestTimer = null;
    }
    if (recentEditTimer) {
      clearTimeout(recentEditTimer);
      recentEditTimer = null;
    }
    mesh.close();
    try {
      await mesh.leave();
    } catch {}
  });

  // ===========================================================================
  // Reservation Enforcement
  // ===========================================================================

  pi.on("tool_call", async (event, ctx) => {
    if (!["edit", "write", "apply_patch", "ast_edit"].includes(event.toolName)) return;

    const input = event.input as Record<string, unknown>;
    const peers = mesh.peers();
    let filePath = "";
    let conflict: ReservationConflict | undefined;
    for (const target of await writeTargets(event.toolName, input)) {
      conflict = findReservationConflicts(target, peers)[0];
      if (!conflict && event.toolName === "ast_edit") {
        const wildcard = target.search(/[*?[\]{}]/);
        const beforeWildcard = wildcard < 0 ? target : target.slice(0, wildcard);
        const prefix =
          wildcard < 0 || beforeWildcard.endsWith("/")
            ? beforeWildcard || "."
            : dirname(beforeWildcard || ".");
        const absoluteTarget = resolve(normalizeCwd(ctx.cwd), prefix);
        for (const peer of peers) {
          for (const reservation of peer.reservations ?? []) {
            const absoluteReservation = resolve(normalizeCwd(peer.cwd), reservation.pattern);
            if (
              absoluteReservation === absoluteTarget ||
              absoluteReservation.startsWith(absoluteTarget + sep) ||
              absoluteTarget.startsWith(absoluteReservation + sep)
            ) {
              conflict = {
                path: target,
                agent: peer.name,
                pattern: reservation.pattern,
                reason: reservation.reason,
                registration: peer,
              };
              break;
            }
          }
          if (conflict) break;
        }
      }
      if (conflict) {
        filePath = target;
        break;
      }
    }
    if (!conflict) return;
    const c = conflict;
    const folder = extractFolder(c.registration.cwd);
    const locationPart = c.registration.gitBranch
      ? ` (in ${folder} on ${c.registration.gitBranch})`
      : ` (in ${folder})`;

    const lines = [filePath, `Reserved by: ${c.agent}${locationPart}`];
    if (c.reason) lines.push(`Reason: "${c.reason}"`);
    lines.push("");
    lines.push(
      `Coordinate via omp_messenger({ action: "send", to: "${c.agent}", message: "..." })`,
    );

    return { block: true, reason: lines.join("\n") };
  });
}
