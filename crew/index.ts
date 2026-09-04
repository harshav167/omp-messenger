/**
 * Crew - Action Router
 * 
 * Routes crew actions to their respective handlers.
 * Simplified: PRD → plan → tasks → work → done
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { MessengerState, Dirs, AgentMailMessage, NameThemeConfig } from "../lib.ts";
import * as handlers from "../handlers.ts";
import type { CrewParams, AppendEntryFn } from "./types.ts";
import { result } from "./utils/result.ts";
import { isPlanningForCwd, cancelPlanningRun, autonomousState, isAutonomousForCwd, stopAutonomous } from "./state.ts";
import { logFeedEvent } from "../feed.ts";

type DeliverFn = (msg: AgentMailMessage) => void;
type UpdateStatusFn = (ctx: ExtensionContext) => void;

export interface CrewActionConfig {
  stuckThreshold?: number;
  crewEventsInFeed?: boolean;
  nameTheme?: NameThemeConfig;
  feedRetention?: number;
}

/**
 * Execute a crew action.
 * 
 * Routes action strings like "task.show" to the appropriate handler.
 */
export async function executeCrewAction(
  action: string,
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  deliverMessage: DeliverFn,
  updateStatus: UpdateStatusFn,
  appendEntry: AppendEntryFn,
  config?: CrewActionConfig,
  signal?: AbortSignal
) {
  const sessionModel = state.model || undefined;
  // Parse action: "task.show" → group="task", op="show"
  const dotIndex = action.indexOf('.');
  const group = dotIndex > 0 ? action.slice(0, dotIndex) : action;
  const op = dotIndex > 0 ? action.slice(dotIndex + 1) : null;

  // ═══════════════════════════════════════════════════════════════════════
  // Actions that DON'T require registration
  // ═══════════════════════════════════════════════════════════════════════

  // join - this is how you register
  if (group === 'join') {
    return handlers.executeJoin(state, dirs, ctx, deliverMessage, updateStatus, params.spec, config?.nameTheme, config?.feedRetention);
  }

  // autoRegisterPath - config management, not agent operation
  if (group === 'autoRegisterPath') {
    if (!params.autoRegisterPath) {
      return result("Error: autoRegisterPath requires value ('add', 'remove', or 'list').",
        { mode: "autoRegisterPath", error: "missing_value" });
    }
    return handlers.executeAutoRegisterPath(params.autoRegisterPath, ctx.cwd);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // All other actions require registration
  // ═══════════════════════════════════════════════════════════════════════
  if (!state.registered) {
    return handlers.notRegisteredError();
  }

  switch (group) {
    // ═══════════════════════════════════════════════════════════════════════
    // Coordination actions (delegate to existing handlers)
    // ═══════════════════════════════════════════════════════════════════════
    case 'status':
      return handlers.executeStatus(state, dirs, ctx.cwd);

    case 'leave':
      return handlers.executeLeave(state, dirs, ctx);

    case 'list':
      return handlers.executeList(state, dirs, ctx.cwd, { stuckThreshold: config?.stuckThreshold });

    case 'whois': {
      if (!params.name) {
        return result("Error: name required for whois action.", { mode: "whois", error: "missing_name" });
      }
      return handlers.executeWhois(state, dirs, ctx.cwd, params.name, { stuckThreshold: config?.stuckThreshold });
    }

    case 'set_status': {
      return handlers.executeSetStatus(state, dirs, ctx, params.message);
    }

    case 'feed': {
      return handlers.executeFeed(ctx.cwd, params.limit, config?.crewEventsInFeed ?? true);
    }

    case 'spec':
      if (!params.spec) {
        return result("Error: spec path required.", { mode: "spec", error: "missing_spec" });
      }
      return handlers.executeSetSpec(state, dirs, ctx, params.spec);

    case 'send':
      return handlers.executeSend(state, dirs, ctx.cwd, params.to, false, params.message, params.replyTo);

    case 'broadcast':
      return handlers.executeSend(state, dirs, ctx.cwd, undefined, true, params.message, params.replyTo);

    case 'reserve':
      if (!params.paths || params.paths.length === 0) {
        return result("Error: paths required for reserve action.", { mode: "reserve", error: "missing_paths" });
      }
      return handlers.executeReserve(state, dirs, ctx, params.paths, params.reason);

    case 'release':
      return handlers.executeRelease(state, dirs, ctx, params.paths ?? true);

    case 'rename':
      if (!params.name) {
        return result("Error: name required for rename action.", { mode: "rename", error: "missing_name" });
      }
      return handlers.executeRename(state, dirs, ctx, params.name, deliverMessage, updateStatus);

    case 'swarm':
      return handlers.executeSwarm(state, dirs, ctx.cwd, params.spec);

    case 'claim':
      if (!params.taskId) {
        return result("Error: taskId required for claim action.", { mode: "claim", error: "missing_taskId" });
      }
      return handlers.executeClaim(state, dirs, ctx, params.taskId, params.spec, params.reason);

    case 'unclaim':
      if (!params.taskId) {
        return result("Error: taskId required for unclaim action.", { mode: "unclaim", error: "missing_taskId" });
      }
      return handlers.executeUnclaim(state, dirs, ctx.cwd, params.taskId, params.spec);

    case 'complete':
      if (!params.taskId) {
        return result("Error: taskId required for complete action.", { mode: "complete", error: "missing_taskId" });
      }
      return handlers.executeComplete(state, dirs, ctx.cwd, params.taskId, params.notes, params.spec);

    // ═══════════════════════════════════════════════════════════════════════
    // Crew actions - Simplified PRD-based workflow
    // ═══════════════════════════════════════════════════════════════════════
    case 'team': {
      if (!op) {
        return result("Error: team action requires operation (e.g., 'team.status', 'team.profile.list').",
          { mode: "team", error: "missing_operation" });
      }
      try {
        const teamHandlers = await import("./handlers/team.ts");
        return teamHandlers.execute(op, params, state, ctx);
      } catch (e) {
        return result(`Error: team.${op} handler failed: ${e instanceof Error ? e.message : 'unknown'}`,
          { mode: "team", error: "handler_error", operation: op });
      }
    }

    case 'task': {
      if (!op) {
        return result("Error: task action requires operation (e.g., 'task.show', 'task.list').",
          { mode: "task", error: "missing_operation" });
      }
      try {
        const taskHandlers = await import("./handlers/task.ts");
        return taskHandlers.execute(op, params, state, ctx);
      } catch (e) {
        return result(`Error: task.${op} handler failed: ${e instanceof Error ? e.message : 'unknown'}`,
          { mode: "task", error: "handler_error", operation: op });
      }
    }

    case 'plan': {
      if (op === 'cancel') {
        const cwd = ctx.cwd;
        if (!isPlanningForCwd(cwd)) {
          return result("No active planning to cancel.", { mode: "plan.cancel" });
        }
        cancelPlanningRun(cwd);
        logFeedEvent(cwd, state.agentName || "unknown", "plan.cancel");
        return result("Planning cancelled.", { mode: "plan.cancel" });
      }
      try {
        const planHandler = await import("./handlers/plan.ts");
        return planHandler.execute(params, ctx, state.agentName || "unknown", () => updateStatus(ctx), sessionModel);
      } catch (e) {
        return result(`Error: plan handler failed: ${e instanceof Error ? e.message : 'unknown'}`,
          { mode: "plan", error: "handler_error" });
      }
    }

    case 'work': {
      if (op === 'stop') {
        const cwd = ctx.cwd;
        if (!isAutonomousForCwd(cwd)) {
          return result("No autonomous work running for this project.", { mode: "work.stop" });
        }
        stopAutonomous("manual");
        appendEntry("crew-state", autonomousState);
        return result("Autonomous work stopped.", { mode: "work.stop", autonomous: false });
      }

      try {
        const workHandler = await import("./handlers/work.ts");
        return workHandler.execute(params, dirs, ctx, appendEntry, signal, sessionModel);
      } catch (e) {
        return result(`Error: work handler failed: ${e instanceof Error ? e.message : 'unknown'}`,
          { mode: "work", error: "handler_error" });
      }
    }

    case 'review': {
      try {
        const reviewHandler = await import("./handlers/review.ts");
        return reviewHandler.execute(params, ctx, sessionModel);
      } catch (e) {
        return result(`Error: review handler failed: ${e instanceof Error ? e.message : 'unknown'}`,
          { mode: "review", error: "handler_error" });
      }
    }

    case 'sync': {
      try {
        const syncHandler = await import("./handlers/sync.ts");
        return syncHandler.execute(params, ctx, sessionModel);
      } catch (e) {
        return result(`Error: sync handler failed: ${e instanceof Error ? e.message : 'unknown'}`,
          { mode: "sync", error: "handler_error" });
      }
    }

    case 'crew': {
      if (!op) {
        return result("Error: crew action requires operation (e.g., 'crew.status', 'crew.agents').",
          { mode: "crew", error: "missing_operation" });
      }
      try {
        const statusHandlers = await import("./handlers/status.ts");
        return statusHandlers.executeCrew(op, ctx);
      } catch (e) {
        return result(`Error: crew.${op} handler failed: ${e instanceof Error ? e.message : 'unknown'}`,
          { mode: "crew", error: "handler_error", operation: op });
      }
    }

    default:
      return result(`Unknown action: ${action}`, { mode: "error", error: "unknown_action", action });
  }
}
