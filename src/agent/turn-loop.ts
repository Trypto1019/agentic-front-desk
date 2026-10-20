import { randomUUID } from "node:crypto";

import type { AgentLimits, StudioConfig } from "../config.ts";
import { localDate } from "../lib/time.ts";
import { SESSION_CHANGING_TOOLS } from "../tools/booking-tools.ts";
import type { ToolContext, ToolRegistry, ToolRunResult, ToolServices } from "../tools/registry.ts";
import { EvidenceIndex, verifierRedraftInstruction, verifyUtterance } from "../verifier/index.ts";
import { encryptAuditEvidence, type TurnAudit } from "./audit.ts";
import { evaluateGroundedConfirmation, shouldRunGroundedConfirmation } from "./guards/grounded-confirmation.ts";
import { guardGeneratedUrls, collectToolResultUrls } from "./guards/url-guard.ts";
import { evaluateReplyValues, valueGateRedraftInstruction } from "./guards/value-gate.ts";
import { assistantMessage, type ChatClient, type ChatMessage, type ToolCall } from "./llm.ts";

/**
 * The agent turn: a bounded tool-use loop with post-model guards.
 *
 *   for iteration ≤ maxLlmIterations (temperature 0.2, no parallel tools):
 *     tool calls?  → run each through the registry (breaker at maxToolCalls)
 *                    a prepared mutation returns the server's "Reply YES" text
 *     final text?  → grounded-confirmation (forced fresh read)
 *                    url guard + value gate + verifier + no-repeat
 *                    any fired → one redraft, then an honest handoff
 *
 * The model's text is sent only if every guard passes. Everything the loop
 * does lands on the turn's audit record.
 */

export const GATE_HANDOFF_TEXT = "I want to get this exactly right, so I've passed your message to the team and they'll follow up.";

export class BreakerError extends Error {}

export type AgentTurnArgs = {
  turnId: string;
  phone: string;
  customerId: string | null;
  inboundText: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  systemPrompt: string;
  now: Date;
  config: StudioConfig;
  limits: AgentLimits;
  chat: ChatClient;
  registry: ToolRegistry;
  services: ToolServices;
  audit: TurnAudit;
};

export type AgentTurnResult = { text: string; source: "model" | "tool" | "guard" };

function parseArgs(call: ToolCall): unknown {
  try {
    return call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return undefined; // the registry's schema check rejects it as invalid_args
  }
}

/** Server-side escalation: a terminal tool failure notifies staff directly, never relying on the model to do it. */
function shouldNotifyStaff(result: ToolRunResult): boolean {
  return result.status === "escalated";
}

function createStaffTask(args: AgentTurnArgs, reason: string, summary: string): void {
  args.services.staffTasks.push({ id: randomUUID(), reason, summary, phone: args.phone, createdAt: args.now.toISOString() });
  args.audit.decisions.push({ kind: "staff_escalation", reason });
}

/**
 * Record what a tool READ as verifier evidence. Only server-produced results
 * become evidence; the rows are the complete answer for their scope.
 */
function recordEvidence(index: EvidenceIndex, call: ToolCall, run: ToolRunResult, args: AgentTurnArgs): void {
  if (run.status !== "executed") return;
  const result = run.result as Record<string, any> | null;
  if (!result) return;
  const base = { id: `${call.function.name}:${call.id}`, observedAt: args.now.getTime(), revision: index.revision, source: { tool: call.function.name, invocationId: call.id } };
  if (Array.isArray(result.openTimes) && typeof result.date === "string") {
    index.addRead({ ...base, authority: "scheduler_read", scope: { date: result.date, room: result.room }, complete: true, rows: result.openTimes.map((time: string) => ({ date: result.date, time, room: result.room })) });
    return;
  }
  if (!args.customerId) return;
  const sessions = Array.isArray(result.sessions) ? result.sessions : Array.isArray(result.candidates) ? result.candidates : result.status === "no_upcoming_session" ? [] : null;
  if (sessions) {
    index.addRead({ ...base, authority: "account_read", customerId: args.customerId, scope: {}, complete: true, rows: sessions.map((s: any) => ({ id: s.session_id, date: s.date, time: s.time, room: s.room })) });
  }
}

export async function runAgentTurn(args: AgentTurnArgs): Promise<AgentTurnResult> {
  const { limits, audit } = args;
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    ...args.history.slice(-12).map((t): ChatMessage => (t.role === "user" ? { role: "user", content: t.text } : assistantMessage(t.text))),
    { role: "user", content: args.inboundText },
  ];
  const tools = args.registry.specs();
  const index = new EvidenceIndex({ customerId: args.customerId, now: () => args.now.getTime(), publicFacts: Object.values(args.config.facts) });
  const toolResultsForEvidence: unknown[] = [];
  const priorToolNames: string[] = [];
  let executedToolCalls = 0;
  let redrafts = 0;

  audit.model = limits.model;
  audit.promptVersion = limits.promptVersion;
  audit.temperature = limits.temperature;

  for (let iteration = 1; iteration <= limits.maxLlmIterations; iteration++) {
    const response = await args.chat({
      model: limits.model,
      messages,
      tools,
      temperature: limits.temperature,
      maxTokens: limits.maxReplyChars,
      timeoutMs: limits.timeoutMs,
      parallelToolCalls: false,
    });
    audit.llmCalls += 1;
    audit.model = response.modelName;

    if (response.toolCalls.length === 0) {
      // GROUNDED-CONFIRMATION: a booking-status question forces a fresh read before any reply.
      if (
        shouldRunGroundedConfirmation({
          inboundText: args.inboundText,
          customerId: args.customerId,
          priorToolNames,
          now: args.now,
          timeZone: args.config.timeZone,
        })
      ) {
        priorToolNames.push("grounded_confirmation_check");
        const evaluation = evaluateGroundedConfirmation({ store: args.services.store, customerId: args.customerId!, inboundText: args.inboundText, now: args.now });
        audit.decisions.push({ kind: "guard", guard: "grounded-confirmation-v1", outcome: evaluation.outcome, asserted: evaluation.asserted.summary });
        audit.toolResults.push({ toolName: "grounded_confirmation_check", outcome: evaluation.outcome, sessionCount: evaluation.sessionCount });
        const upcoming = args.services.store.upcomingSessions(args.customerId!, args.now);
        index.addRead({
          id: `grounded:${args.turnId}`,
          authority: "account_read",
          customerId: args.customerId!,
          scope: {},
          complete: true,
          rows: upcoming.map((s) => ({ id: s.id, date: s.date, time: s.time, room: s.room })),
          observedAt: args.now.getTime(),
          revision: index.revision,
          source: { tool: "grounded_confirmation_check", invocationId: args.turnId },
        });
        if (evaluation.outcome === "mismatch") {
          // The model's text is never sent for this turn.
          audit.decisions.push({ kind: "guard", guard: "grounded-confirmation-v1", action: "blocked_model_text", encryptedOriginal: encryptAuditEvidence(response.content, args.turnId) });
          createStaffTask(args, "grounded_confirmation_mismatch", `Customer asserted a booking (${evaluation.asserted.summary ?? "unspecified"}) that the schedule does not show.`);
          return { text: evaluation.text, source: "guard" };
        }
        toolResultsForEvidence.push(evaluation.modelContext);
        messages.push(assistantMessage(response.content));
        messages.push({ role: "system", content: evaluation.modelContext });
        continue;
      }

      const draft = response.content.trim().slice(0, limits.maxReplyChars);
      const url = guardGeneratedUrls(draft, args.config, toolResultsForEvidence.flatMap(collectToolResultUrls));
      const values = evaluateReplyValues({
        reply: draft,
        evidence: toolResultsForEvidence,
        inboundText: [args.inboundText, ...args.history.filter((t) => t.role === "user").map((t) => t.text)].join("\n"),
        now: args.now,
        timeZone: args.config.timeZone,
        facts: args.config.facts,
      });
      const verification = verifyUtterance(draft, index, { calendarDate: localDate(args.now, args.config.timeZone), rooms: args.config.rooms });
      const previous = [...args.history].reverse().find((t) => t.role === "assistant")?.text;
      const repeats = !!previous && previous.trim().toLowerCase() === draft.toLowerCase();
      const empty = draft.length === 0;

      const fired = { url: !url.allowed, values: values.fired, verifier: verification.proof.decision === "WITHHOLD", repeats, empty };
      audit.decisions.push({
        kind: "post_model_guards",
        iteration,
        ...fired,
        ...(url.allowed ? {} : { blockedUrls: url.blockedUrls }),
        ...(values.fired ? { valueViolations: values.violations } : {}),
        ...(fired.verifier ? { verifierFindings: verification.proof.results.filter((r) => r.status !== "supported") } : {}),
        ...(Object.values(fired).some(Boolean) ? { encryptedOriginal: encryptAuditEvidence(draft, args.turnId) } : {}),
      });

      if (Object.values(fired).some(Boolean)) {
        if (redrafts < 1 && iteration < limits.maxLlmIterations) {
          redrafts += 1;
          messages.push(assistantMessage(draft));
          messages.push({
            role: "system",
            content: [
              fired.url ? "Your draft contained a link the server did not provide, so it was not sent. Never write a link that is not in a tool result or the approved list." : "",
              fired.values ? valueGateRedraftInstruction(values) : "",
              fired.verifier ? verifierRedraftInstruction(verification) : "",
              fired.repeats ? "Your draft repeated your previous message word for word. Respond to what the customer just said, differently." : "",
              fired.empty ? "Your draft was empty. Reply to the customer." : "",
            ]
              .filter(Boolean)
              .join(" "),
          });
          continue;
        }
        createStaffTask(args, "guard_redraft_failed", `Assistant draft blocked twice (${Object.entries(fired).filter(([, v]) => v).map(([k]) => k).join(", ")}).`);
        return { text: GATE_HANDOFF_TEXT, source: "guard" };
      }
      return { text: draft, source: "model" };
    }

    messages.push(response.message);
    for (const call of response.toolCalls) {
      if (executedToolCalls >= limits.maxToolCalls) throw new BreakerError("agent_breaker:max_tool_calls");
      executedToolCalls += 1;
      const rawArgs = parseArgs(call);
      audit.toolCalls.push({ id: call.id, name: call.function.name, arguments: rawArgs ?? call.function.arguments });

      const ctx: ToolContext = {
        phone: args.phone,
        customerId: args.customerId,
        channel: "sms",
        turnId: args.turnId,
        now: args.now,
        services: args.services,
        decisions: audit.decisions,
        priorToolNames,
      };
      const run = await args.registry.run(call.function.name, rawArgs, ctx);
      priorToolNames.push(call.function.name);
      audit.toolResults.push({ toolName: run.toolName, status: run.status, ...("result" in run ? { result: run.result } : {}), ...("reason" in run ? { reason: run.reason } : {}) });
      toolResultsForEvidence.push("result" in run ? run.result : run);
      recordEvidence(index, call, run, args);

      if (shouldNotifyStaff(run)) createStaffTask(args, `tool_${run.status}:${"reason" in run ? run.reason : ""}`, `${run.toolName} could not run autonomously.`);

      // The tool owns the consequential sentence: the server's "Reply YES" prompt goes out verbatim.
      if (run.status === "confirmation_needed" && SESSION_CHANGING_TOOLS.has(run.toolName)) {
        return { text: run.message, source: "tool" };
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify({ registryStatus: run.status, ...("result" in run ? { result: run.result } : { message: run.message }) }),
      });
    }
  }
  throw new BreakerError("agent_breaker:max_llm_iterations");
}
