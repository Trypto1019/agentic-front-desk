import { z } from "zod";

import type { PendingIntentStore } from "../state/pending-intent.ts";
import type { BookingStore } from "./booking-store.ts";

/**
 * Guarded tool registry.
 *
 * Every tool declares a zod schema and an autonomy level. `runTool` is the
 * only way the agent reaches a tool, and it always runs the same pipeline:
 *
 *   validate args (zod) ──invalid──▶ rejected  ("ask a clarifying question")
 *   kill-switch gate    ──off──────▶ escalated (settings-driven, per tool + global)
 *   autonomy level:
 *     escalate          ─────────────▶ escalated (staff only)
 *     confirm_required  ─prepareOnly─▶ prepare a PendingIntent; server sends "Reply YES"
 *     auto_write_guarded─guard()─────▶ clarify | defer | escalate | execute
 *     auto_read         ─────────────▶ execute
 *
 * Every branch records an autonomy decision on the turn's audit record.
 * With AGENT_TOOL_DRY_RUN=1 (or ctx.dryRun) every tool runs without writes;
 * the eval harness and transcript replays use this.
 */

export type AutonomyLevel = "auto_read" | "auto_write_guarded" | "confirm_required" | "escalate";

export type Settings = Map<string, boolean>;

export type ToolServices = {
  store: BookingStore;
  intents: PendingIntentStore;
  settings: Settings;
  staffTasks: StaffTask[];
};

export type StaffTask = { id: string; reason: string; summary: string; phone: string; createdAt: string };

export type ToolContext = {
  phone: string;
  customerId: string | null;
  channel: "sms" | "voice";
  turnId: string;
  now: Date;
  dryRun?: boolean;
  services: ToolServices;
  /** The turn's audit sink for autonomy decisions. */
  decisions: Array<Record<string, unknown>>;
  /** Tool names already executed this turn (guards may consult it). */
  priorToolNames: readonly string[];
};

export type GuardResult =
  | { allowed: true; reason: string }
  | { allowed: false; action: "clarify" | "defer" | "escalate"; reason: string; message: string };

export type AgentTool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  autonomyLevel: AutonomyLevel;
  prepareOnly?: boolean;
  guard?: (args: z.infer<S>, ctx: ToolContext) => GuardResult;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;
};

export type ToolRunResult =
  | { status: "rejected"; toolName: string; reason: "invalid_args"; message: string; issues: unknown }
  | { status: "escalated"; toolName: string; reason: string; message: string }
  | { status: "clarify" | "deferred"; toolName: string; reason: string; message: string }
  | { status: "confirmation_needed"; toolName: string; reason: string; message: string; result: unknown }
  | { status: "executed"; toolName: string; result: unknown; dryRun: boolean };

/** Define a tool with its args type inferred from the schema. */
export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool {
  return tool as unknown as AgentTool;
}

export const GLOBAL_KILL_SWITCH = "agent_autonomy_enabled";
export const toolKillSwitch = (name: string) => `agent_tool_${name}_enabled`;

function gateAllows(name: string, settings: Settings): { allowed: boolean; key: string } {
  if (settings.get(GLOBAL_KILL_SWITCH) === false) return { allowed: false, key: GLOBAL_KILL_SWITCH };
  const key = toolKillSwitch(name);
  return { allowed: settings.get(key) !== false, key };
}

export function isDryRun(ctx: ToolContext, env: NodeJS.ProcessEnv = process.env): boolean {
  return ctx.dryRun === true || env.AGENT_TOOL_DRY_RUN === "1";
}

export class ToolRegistry {
  private readonly byName: Map<string, AgentTool>;

  constructor(readonly tools: readonly AgentTool[]) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** OpenAI-style function specs for the chat request (one schema source: zod). */
  specs(): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
    return this.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) },
    }));
  }

  async run(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolRunResult> {
    const tool = this.byName.get(name);
    const decide = (outcome: string, reason: string, extra: Record<string, unknown> = {}) =>
      ctx.decisions.push({ kind: "tool_autonomy", tool: name, autonomyLevel: tool?.autonomyLevel ?? null, outcome, reason, ...extra });

    if (!tool) {
      decide("rejected", "unknown_tool");
      return { status: "rejected", toolName: name, reason: "invalid_args", message: "That tool does not exist. Ask a clarifying question.", issues: null };
    }

    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = z.treeifyError(parsed.error);
      decide("rejected", "invalid_args", { validation: issues });
      return { status: "rejected", toolName: name, reason: "invalid_args", message: "The tool arguments were invalid. Ask a clarifying question.", issues };
    }

    const gate = gateAllows(name, ctx.services.settings);
    if (!gate.allowed) {
      decide("escalated", "kill_switch_disabled", { gate: gate.key });
      return { status: "escalated", toolName: name, reason: "kill_switch_disabled", message: "This tool is disabled. Hand off to staff instead." };
    }

    const dryRun = isDryRun(ctx);
    const runCtx: ToolContext = { ...ctx, dryRun };

    switch (tool.autonomyLevel) {
      case "escalate":
        decide("escalated", "tool_escalate_only");
        return { status: "escalated", toolName: name, reason: "tool_escalate_only", message: "This request must be handled by staff." };

      case "confirm_required": {
        if (!tool.prepareOnly) {
          decide("confirmation_needed", "confirm_required");
          return { status: "confirmation_needed", toolName: name, reason: "confirm_required", message: "Ask the customer to reply YES before taking this action.", result: null };
        }
        decide("prepare_confirmation", "prepare_only_confirm_required", { dryRun });
        return this.executePrepare(tool, parsed.data, runCtx);
      }

      case "auto_write_guarded": {
        if (!tool.guard) {
          decide("escalated", "missing_guard");
          return { status: "escalated", toolName: name, reason: "missing_guard", message: "This write tool has no guard. Hand off instead of executing." };
        }
        const guard = tool.guard(parsed.data, runCtx);
        if (!guard.allowed) {
          decide(guard.action, guard.reason);
          if (guard.action === "escalate") return { status: "escalated", toolName: name, reason: guard.reason, message: guard.message };
          return { status: guard.action === "clarify" ? "clarify" : "deferred", toolName: name, reason: guard.reason, message: guard.message };
        }
        decide("execute", guard.reason, { dryRun });
        return this.executeObserved(tool, parsed.data, runCtx);
      }

      case "auto_read":
        decide("execute", "auto_read", { dryRun });
        return this.executeObserved(tool, parsed.data, runCtx);
    }
  }

  private async executeObserved(tool: AgentTool, args: unknown, ctx: ToolContext): Promise<ToolRunResult> {
    try {
      const result = await tool.execute(args, ctx);
      return { status: "executed", toolName: tool.name, result, dryRun: ctx.dryRun === true };
    } catch (error) {
      ctx.decisions.push({ kind: "tool_error", tool: tool.name, error: error instanceof Error ? error.message : String(error) });
      return { status: "escalated", toolName: tool.name, reason: "tool_error", message: "Something went wrong on our side. Hand off to staff." };
    }
  }

  /** Prepare tools return either a prepared intent (server-composed "Reply YES") or a clarify result. */
  private async executePrepare(tool: AgentTool, args: unknown, ctx: ToolContext): Promise<ToolRunResult> {
    const run = await this.executeObserved(tool, args, ctx);
    if (run.status !== "executed") return run;
    const result = run.result as { status?: string; message?: string } | null;
    if (result?.status === "prepared" && typeof result.message === "string") {
      return { status: "confirmation_needed", toolName: tool.name, reason: "prepared", message: result.message, result };
    }
    return run;
  }
}
