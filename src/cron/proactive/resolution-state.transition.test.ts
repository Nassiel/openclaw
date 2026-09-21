// Unit coverage for the pure resolution-transition helper (task 5.1 helper used
// by task 9.2). Exercises resolve/abandon/none transitions, the pending-only
// guard, and idempotence on an already-terminal state.
//
// Requirements: 4.1, 4.4
import { describe, expect, it } from "vitest";
import { applyResolutionTransition, type ProactiveRuntimeState } from "./resolution-state.js";

function pendingState(overrides?: Partial<ProactiveRuntimeState>): ProactiveRuntimeState {
  return { resolutionState: "pending", unansweredCount: 0, ...overrides };
}

describe("applyResolutionTransition", () => {
  it("sets resolved on a pending topic (Req 4.1)", () => {
    const next = applyResolutionTransition(pendingState({ unansweredCount: 2 }), "resolve");
    expect(next.resolutionState).toBe("resolved");
    // Only the resolution state moves; the streak is a separate concern.
    expect(next.unansweredCount).toBe(2);
  });

  it("sets abandoned on a pending topic (Req 4.4)", () => {
    const next = applyResolutionTransition(pendingState(), "abandon");
    expect(next.resolutionState).toBe("abandoned");
  });

  it("returns the state unchanged for a none transition (identity)", () => {
    const state = pendingState({ unansweredCount: 3 });
    const next = applyResolutionTransition(state, "none");
    expect(next).toBe(state);
  });

  it("is a no-op once the topic is terminal", () => {
    const resolved = pendingState({ resolutionState: "resolved" });
    expect(applyResolutionTransition(resolved, "abandon").resolutionState).toBe("resolved");

    const abandoned = pendingState({ resolutionState: "abandoned" });
    expect(applyResolutionTransition(abandoned, "resolve").resolutionState).toBe("abandoned");
  });

  it("does not mutate the input state", () => {
    const state = pendingState({ unansweredCount: 1 });
    applyResolutionTransition(state, "resolve");
    expect(state.resolutionState).toBe("pending");
  });
});
