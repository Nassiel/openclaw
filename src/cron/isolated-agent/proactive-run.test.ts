// Unit tests for proactive-run.ts: the delivery → outcome → resolution-state
// wiring that constitutes task 6.5. Covers the three terminal paths (withheld /
// delivered / failed) and verifies the resolution-state transition on delivered,
// including the max-unanswered auto-abandon boundary.
//
// Requirements: 3.1, 3.2, 3.3, 3.4, 5.4, 5.5, 5.8
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import type { ProactiveRuntimeState } from "../proactive/resolution-state.js";
import type { CronDeliverySuppressionReason, ProactiveGuardrailConfig } from "../types.js";
import type { ProactiveDecision, ProactiveOpeningMessage } from "./proactive-decision.js";

// Mock the existing cron announce owner so the runtime delivery adapter is
// exercised without the channel transport (task 6.5, Req 3.2, 3.3, 3.4).
const announceMocks = vi.hoisted(() => ({ sendCronAnnouncePayloadStrict: vi.fn() }));
vi.mock("../delivery.js", () => ({
  sendCronAnnouncePayloadStrict: announceMocks.sendCronAnnouncePayloadStrict,
}));

import {
  buildProactiveDeliveryPlan,
  buildRuntimeProactiveOpeningDelivery,
  runProactiveCheckIn,
  type ProactiveDeliveryResult,
  type ProactiveOpeningDeliveryFn,
} from "./proactive-run.js";

function makeMockDetail(snippet = "finish the deployment doc"): MemorySearchResult {
  return {
    path: "sessions/topic-42.md",
    startLine: 1,
    endLine: 10,
    score: 8.5,
    snippet,
    source: "memory",
  };
}

function makeMockMessage(overrides?: Partial<ProactiveOpeningMessage>): ProactiveOpeningMessage {
  const detail = makeMockDetail();
  return {
    deliveryChannel: "slack",
    text: `Earlier you mentioned: "${detail.snippet}". Want to pick that back up?`,
    referencedDetail: detail,
    recalledDetails: [detail],
    ...overrides,
  };
}

function pendingState(overrides?: Partial<ProactiveRuntimeState>): ProactiveRuntimeState {
  return {
    resolutionState: "pending",
    unansweredCount: 0,
    ...overrides,
  };
}

function guardrails(overrides?: Partial<ProactiveGuardrailConfig>): ProactiveGuardrailConfig {
  return {
    minIntervalSeconds: 3600,
    maxUnanswered: 3,
    ...overrides,
  };
}

function makeDeliverFn(result: ProactiveDeliveryResult): ProactiveOpeningDeliveryFn {
  return vi.fn(async () => result);
}

describe("runProactiveCheckIn", () => {
  describe("withheld path (guardrail suppression)", () => {
    it("produces not-delivered with the guardrail suppression reason (Req 3.6, 5.8)", async () => {
      const reason: CronDeliverySuppressionReason = "quiet_hours";
      const decision: ProactiveDecision = {
        kind: "withhold",
        source: { kind: "guardrail", reason },
        deliverySuppressionReason: reason,
      };
      const deliver = makeDeliverFn({ delivered: true });
      const state = pendingState({ unansweredCount: 1 });

      const result = await runProactiveCheckIn({
        decision,
        state,
        guardrails: guardrails(),
        targetUser: "user-1",
        firingAtMs: 1_000_000,
        deliver,
      });

      // Delivery was never attempted.
      expect(deliver).not.toHaveBeenCalled();

      // Run outcome: OK with not-delivered + suppression reason.
      expect(result.outcome.status).toBe("ok");
      expect(result.outcome.delivered).toBe(false);
      expect(result.outcome.deliveryAttempted).toBe(false);
      expect(result.outcome.deliveryState.status).toBe("not-delivered");
      expect(result.outcome.deliveryState.delivered).toBe(false);
      expect(result.outcome.deliverySuppressionReason).toBe(reason);
      expect(result.outcome.deliveryState.deliverySuppressionReason).toBe(reason);

      // Proactive state unchanged — withheld occurrences never reached the user.
      expect(result.proactiveState).toEqual(state);
    });

    it("carries recall diagnostics and no suppression reason for recall-gap withholds (Req 2.3-2.5)", async () => {
      const diagnostics = {
        summary: "proactive recall recall_timeout",
        entries: [
          {
            ts: 100_000,
            source: "cron-setup" as const,
            severity: "warn" as const,
            message: "proactive recall timed out after 5000ms",
          },
        ],
      };
      const decision: ProactiveDecision = {
        kind: "withhold",
        source: { kind: "recall", reason: "recall_timeout" },
        diagnostics,
      };
      const state = pendingState();
      const deliver = makeDeliverFn({ delivered: true });

      const result = await runProactiveCheckIn({
        decision,
        state,
        guardrails: guardrails(),
        targetUser: "user-1",
        firingAtMs: 1_000_000,
        deliver,
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(result.outcome.status).toBe("ok");
      expect(result.outcome.deliverySuppressionReason).toBeUndefined();
      expect(result.outcome.diagnostics).toBe(diagnostics);
      expect(result.proactiveState).toEqual(state);
    });
  });

  describe("delivered path", () => {
    it("records delivered and increments unansweredCount (Req 3.3, 5.4)", async () => {
      const message = makeMockMessage();
      const decision: ProactiveDecision = { kind: "deliver", message };
      const state = pendingState({ unansweredCount: 0 });
      const firingAtMs = 2_000_000;
      const deliver = makeDeliverFn({ delivered: true });

      const result = await runProactiveCheckIn({
        decision,
        state,
        guardrails: guardrails({ maxUnanswered: 3 }),
        targetUser: "user-1",
        firingAtMs,
        deliver,
      });

      expect(deliver).toHaveBeenCalledOnce();
      expect(result.outcome.status).toBe("ok");
      expect(result.outcome.delivered).toBe(true);
      expect(result.outcome.deliveryAttempted).toBe(true);
      expect(result.outcome.deliveryState.status).toBe("delivered");
      expect(result.outcome.deliveryState.delivered).toBe(true);
      expect(result.outcome.deliverySuppressionReason).toBeUndefined();

      // State transition: unansweredCount incremented, lastOpeningMessageAtMs stamped.
      expect(result.proactiveState.unansweredCount).toBe(1);
      expect(result.proactiveState.lastOpeningMessageAtMs).toBe(firingAtMs);
      expect(result.proactiveState.resolutionState).toBe("pending");
    });

    it("auto-abandons at maxUnanswered (Req 5.5)", async () => {
      const message = makeMockMessage();
      const decision: ProactiveDecision = { kind: "deliver", message };
      // Already at maxUnanswered - 1; next delivery pushes to max and abandons.
      const state = pendingState({ unansweredCount: 2 });
      const deliver = makeDeliverFn({ delivered: true });

      const result = await runProactiveCheckIn({
        decision,
        state,
        guardrails: guardrails({ maxUnanswered: 3 }),
        targetUser: "user-1",
        firingAtMs: 3_000_000,
        deliver,
      });

      expect(result.outcome.status).toBe("ok");
      expect(result.outcome.delivered).toBe(true);
      expect(result.proactiveState.unansweredCount).toBe(3);
      expect(result.proactiveState.resolutionState).toBe("abandoned");
    });

    it("passes message, targetUser, and firingAtMs to the delivery function", async () => {
      const message = makeMockMessage({ deliveryChannel: "telegram" });
      const decision: ProactiveDecision = { kind: "deliver", message };
      const deliver = vi.fn(async () => ({ delivered: true }));

      await runProactiveCheckIn({
        decision,
        state: pendingState(),
        guardrails: guardrails(),
        targetUser: "user-42",
        firingAtMs: 5_000_000,
        deliver,
      });

      expect(deliver).toHaveBeenCalledWith({
        message,
        targetUser: "user-42",
        firingAtMs: 5_000_000,
      });
    });
  });

  describe("failed delivery path", () => {
    it("records failed delivery as a run error with no suppression reason (Req 3.4)", async () => {
      const message = makeMockMessage();
      const decision: ProactiveDecision = { kind: "deliver", message };
      const state = pendingState({ unansweredCount: 1 });
      const error = "Channel transport error: connection refused";
      const deliver = makeDeliverFn({ delivered: false, error });

      const result = await runProactiveCheckIn({
        decision,
        state,
        guardrails: guardrails(),
        targetUser: "user-1",
        firingAtMs: 4_000_000,
        deliver,
      });

      expect(result.outcome.status).toBe("error");
      expect(result.outcome.error).toBe(error);
      expect(result.outcome.delivered).toBe(false);
      expect(result.outcome.deliveryAttempted).toBe(true);
      expect(result.outcome.deliveryError).toBe(error);
      expect(result.outcome.deliveryState.status).toBe("not-delivered");
      expect(result.outcome.deliveryState.error).toBe(error);
      // No suppression reason — this is a genuine failure, not a guardrail withhold.
      expect(result.outcome.deliverySuppressionReason).toBeUndefined();
      expect(result.outcome.deliveryState.deliverySuppressionReason).toBeUndefined();

      // State unchanged — nothing reached the user.
      expect(result.proactiveState).toEqual(state);
    });
  });
});

describe("buildProactiveDeliveryPlan", () => {
  it("produces an announce plan for the given channel", () => {
    const plan = buildProactiveDeliveryPlan({ channel: "slack", to: "C123456" });

    expect(plan.mode).toBe("announce");
    expect(plan.channel).toBe("slack");
    expect(plan.to).toBe("C123456");
    expect(plan.source).toBe("delivery");
    expect(plan.requested).toBe(true);
  });
});

describe("buildRuntimeProactiveOpeningDelivery", () => {
  const runtime = {
    cfg: {} as never,
    deps: {} as never,
    agentId: "agent-1",
    jobId: "job-1",
    sessionKey: "agent:agent-1:user-1",
    abortSignal: new AbortController().signal,
  };

  beforeEach(() => {
    announceMocks.sendCronAnnouncePayloadStrict.mockReset();
  });

  it("routes the opening message through the real channel and reports delivered (Req 3.3)", async () => {
    announceMocks.sendCronAnnouncePayloadStrict.mockResolvedValue({ status: "sent" });
    const deliver = buildRuntimeProactiveOpeningDelivery(runtime);
    const message = makeMockMessage({ deliveryChannel: "slack" });

    const result = await deliver({ message, targetUser: "user-1", firingAtMs: 1_000 });

    expect(result).toEqual({ delivered: true });
    expect(announceMocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledOnce();
    const call = announceMocks.sendCronAnnouncePayloadStrict.mock.calls[0]![0];
    expect(call.target.channel).toBe("slack");
    expect(call.target.sessionKey).toBe(runtime.sessionKey);
    expect(call.payload).toEqual({ text: message.text });
    expect(call.jobId).toBe("job-1");
    expect(call.agentId).toBe("agent-1");
  });

  it("refuses the internal 'cron' channel without attempting a send (Req 3.2)", async () => {
    const deliver = buildRuntimeProactiveOpeningDelivery(runtime);
    const message = makeMockMessage({ deliveryChannel: "cron" });

    const result = await deliver({ message, targetUser: "user-1", firingAtMs: 1_000 });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("cron");
    expect(announceMocks.sendCronAnnouncePayloadStrict).not.toHaveBeenCalled();
  });

  it("maps a channel send failure to a delivery failure (Req 3.4)", async () => {
    announceMocks.sendCronAnnouncePayloadStrict.mockRejectedValue(new Error("connection refused"));
    const deliver = buildRuntimeProactiveOpeningDelivery(runtime);
    const message = makeMockMessage({ deliveryChannel: "telegram" });

    const result = await deliver({ message, targetUser: "user-1", firingAtMs: 1_000 });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("connection refused");
  });
});
