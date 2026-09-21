// Example coverage for the occurrence short-circuit contract read by the single
// occurrence-evaluation gate (isRunnableJob) on both the live scheduling and
// restart catch-up paths: a proactive check-in whose live resolutionState is
// resolved/abandoned cancels the occurrence with no turn and no send, while a
// pending topic keeps being evaluated. The live `proactive` block is
// authoritative over the payload's initial resolutionState, with the payload
// value as the pre-migration legacy fallback (Req 3.5, 4.2, 4.3, 4.5, 4.6, 4.7).
import { describe, expect, it } from "vitest";
import type { CronJob, CronProactiveResolutionState } from "../types.js";
import {
  isProactiveOccurrenceSuppressed,
  resolveProactiveResolutionState,
} from "./resolution-state.js";

function proactiveJob(params: {
  payloadResolutionState: CronProactiveResolutionState;
  liveResolutionState?: CronProactiveResolutionState;
}): CronJob {
  const state: CronJob["state"] =
    params.liveResolutionState === undefined
      ? {}
      : { proactive: { resolutionState: params.liveResolutionState, unansweredCount: 0 } };
  return {
    payload: {
      kind: "proactiveCheckIn",
      pendingTopicRef: "topic-deploy-doc",
      targetUser: "user-1",
      deliveryChannel: "discord",
      resolutionState: params.payloadResolutionState,
      guardrails: { minIntervalSeconds: 3600, maxUnanswered: 3 },
    },
    state,
  } as unknown as CronJob;
}

function agentTurnJob(): CronJob {
  return {
    payload: { kind: "agentTurn", message: "hi" },
    state: {},
  } as unknown as CronJob;
}

describe("proactive occurrence suppression", () => {
  it("prefers the live proactive resolutionState over the payload initial value", () => {
    const job = proactiveJob({
      payloadResolutionState: "pending",
      liveResolutionState: "abandoned",
    });
    expect(resolveProactiveResolutionState(job)).toBe("abandoned");
    expect(isProactiveOccurrenceSuppressed(job)).toBe(true);
  });

  it("falls back to the payload resolutionState for a legacy row without a proactive block", () => {
    const resolved = proactiveJob({ payloadResolutionState: "resolved" });
    expect(resolveProactiveResolutionState(resolved)).toBe("resolved");
    expect(isProactiveOccurrenceSuppressed(resolved)).toBe(true);

    const pending = proactiveJob({ payloadResolutionState: "pending" });
    expect(resolveProactiveResolutionState(pending)).toBe("pending");
    expect(isProactiveOccurrenceSuppressed(pending)).toBe(false);
  });

  it("suppresses resolved and abandoned occurrences but not pending ones", () => {
    for (const terminal of ["resolved", "abandoned"] as const) {
      expect(
        isProactiveOccurrenceSuppressed(
          proactiveJob({ payloadResolutionState: "pending", liveResolutionState: terminal }),
        ),
      ).toBe(true);
    }
    expect(
      isProactiveOccurrenceSuppressed(
        proactiveJob({ payloadResolutionState: "resolved", liveResolutionState: "pending" }),
      ),
    ).toBe(false);
  });

  it("never classifies a non-proactive job", () => {
    const job = agentTurnJob();
    expect(resolveProactiveResolutionState(job)).toBeUndefined();
    expect(isProactiveOccurrenceSuppressed(job)).toBe(false);
  });
});
