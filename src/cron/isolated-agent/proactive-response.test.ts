// Example coverage for the proactive resolution write path (task 9.2): a
// proactive turn processing a user response, and an explicit resolve/abandon
// action written directly on the job. Verifies the resolutionState transition,
// the unansweredCount reset on a user response, and the precedence of an
// explicit action over agent judgment.
//
// Requirements: 4.1, 4.4, 5.6
import { describe, expect, it } from "vitest";
import type { ProactiveRuntimeState } from "../proactive/resolution-state.js";
import { applyProactiveExplicitAction, applyProactiveUserResponse } from "./proactive-response.js";

function pendingState(overrides?: Partial<ProactiveRuntimeState>): ProactiveRuntimeState {
  return {
    resolutionState: "pending",
    unansweredCount: 0,
    ...overrides,
  };
}

/** Asserts the shared not-delivered outcome shape a resolution write records. */
function expectNotDeliveredOutcome(outcome: {
  status: string;
  delivered: boolean;
  deliveryAttempted: boolean;
  deliveryState: { status: string; delivered: boolean };
  deliverySuppressionReason?: unknown;
}): void {
  expect(outcome.status).toBe("ok");
  expect(outcome.delivered).toBe(false);
  expect(outcome.deliveryAttempted).toBe(false);
  expect(outcome.deliveryState.status).toBe("not-delivered");
  expect(outcome.deliveryState.delivered).toBe(false);
  // A resolution turn is not a guardrail withhold — no suppression reason.
  expect(outcome.deliverySuppressionReason).toBeUndefined();
}

describe("applyProactiveUserResponse", () => {
  it("resets the unanswered count and stamps the response time (Req 5.6)", () => {
    const state = pendingState({ unansweredCount: 2, lastOpeningMessageAtMs: 1_000 });
    const respondedAtMs = 9_000;

    const result = applyProactiveUserResponse({
      state,
      respondedAtMs,
      topicComplete: false,
    });

    expect(result.proactiveState.unansweredCount).toBe(0);
    expect(result.proactiveState.lastUserResponseAtMs).toBe(respondedAtMs);
    // An incomplete reply leaves the topic pending so a recurring schedule keeps
    // nudging (Req 4.3).
    expect(result.proactiveState.resolutionState).toBe("pending");
    // The last opening-message stamp is untouched by a reply.
    expect(result.proactiveState.lastOpeningMessageAtMs).toBe(1_000);
    expectNotDeliveredOutcome(result.outcome);
  });

  it("resolves the topic when the agent judges the reply complete (Req 4.1)", () => {
    const state = pendingState({ unansweredCount: 3 });

    const result = applyProactiveUserResponse({
      state,
      respondedAtMs: 5_000,
      topicComplete: true,
    });

    expect(result.proactiveState.resolutionState).toBe("resolved");
    // The reply still resets the streak regardless of the resolution outcome.
    expect(result.proactiveState.unansweredCount).toBe(0);
    expect(result.proactiveState.lastUserResponseAtMs).toBe(5_000);
  });

  it("lets an explicit resolve override an agent judgment of incomplete (Req 4.1)", () => {
    const state = pendingState({ unansweredCount: 1 });

    const result = applyProactiveUserResponse({
      state,
      respondedAtMs: 7_000,
      topicComplete: false,
      explicitAction: "resolve",
    });

    // Explicit action wins over agent judgment.
    expect(result.proactiveState.resolutionState).toBe("resolved");
    expect(result.proactiveState.unansweredCount).toBe(0);
  });

  it("lets an explicit abandon override an agent judgment of complete (Req 4.4)", () => {
    const state = pendingState({ unansweredCount: 1 });

    const result = applyProactiveUserResponse({
      state,
      respondedAtMs: 8_000,
      topicComplete: true,
      explicitAction: "abandon",
    });

    // Explicit action takes precedence even when the agent judged the topic done.
    expect(result.proactiveState.resolutionState).toBe("abandoned");
    expect(result.proactiveState.unansweredCount).toBe(0);
  });

  it("does not mutate the input state", () => {
    const state = pendingState({ unansweredCount: 4 });

    applyProactiveUserResponse({ state, respondedAtMs: 1, topicComplete: true });

    expect(state.unansweredCount).toBe(4);
    expect(state.resolutionState).toBe("pending");
  });
});

describe("applyProactiveExplicitAction", () => {
  it("writes resolved directly on the job (Req 4.1)", () => {
    const state = pendingState({ unansweredCount: 2, lastOpeningMessageAtMs: 3_000 });

    const result = applyProactiveExplicitAction({ state, action: "resolve" });

    expect(result.proactiveState.resolutionState).toBe("resolved");
    // No user reply here, so the streak and stamps are untouched.
    expect(result.proactiveState.unansweredCount).toBe(2);
    expect(result.proactiveState.lastOpeningMessageAtMs).toBe(3_000);
    expect(result.proactiveState.lastUserResponseAtMs).toBeUndefined();
    expectNotDeliveredOutcome(result.outcome);
  });

  it("writes abandoned directly on the job (Req 4.4)", () => {
    const state = pendingState({ unansweredCount: 1 });

    const result = applyProactiveExplicitAction({ state, action: "abandon" });

    expect(result.proactiveState.resolutionState).toBe("abandoned");
    expect(result.proactiveState.unansweredCount).toBe(1);
  });

  it("is a no-op on an already-terminal state (idempotent)", () => {
    const resolved = pendingState({ resolutionState: "resolved", unansweredCount: 0 });

    const result = applyProactiveExplicitAction({ state: resolved, action: "abandon" });

    // Once terminal, the topic no longer transitions.
    expect(result.proactiveState.resolutionState).toBe("resolved");
  });
});
