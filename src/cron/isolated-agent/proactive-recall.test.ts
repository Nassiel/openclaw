// Example tests for the proactive check-in recall I/O paths (Req 2.3-2.6).
//
// These cover the four recall outcomes the trigger-time turn must handle:
//   - timeout   -> withhold recall_timeout (+ diagnostic)
//   - error     -> withhold recall_error (+ diagnostic)
//   - empty ok  -> withhold recall_empty (+ diagnostic)
//   - non-empty -> proceed carrying the recalled details
//
// The recall interface is injectable, so the memory runtime is never loaded:
// `mapProactiveRecallOutcome` is a pure mapping tested directly, and
// `performProactiveRecall` is exercised with a deterministic mock
// `ProactiveRecallFn`. `nowMs` is injected so the diagnostics timestamps are
// deterministic and assertable.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import {
  mapProactiveRecallOutcome,
  performProactiveRecall,
  PROACTIVE_RECALL_TIMEOUT_MS,
  type ProactiveRecallAttempt,
  type ProactiveRecallFn,
} from "./proactive-recall.js";

const FIXED_NOW_MS = 1_700_000_000_000;
const nowMs = () => FIXED_NOW_MS;

/** Minimal recalled detail; only the fields the outcome carries need to be real. */
function makeDetail(snippet: string): MemorySearchResult {
  return {
    path: "notes/deploy-doc.md",
    startLine: 1,
    endLine: 4,
    score: 0.9,
    snippet,
    source: "memory",
  };
}

/** Deterministic recall stub so no memory runtime is loaded. */
function recallReturning(attempt: ProactiveRecallAttempt): ProactiveRecallFn {
  return async () => attempt;
}

const RECALL_PARAMS = {
  cfg: {} as OpenClawConfig,
  agentId: "agent-1",
  sessionKey: "session:user-1",
  pendingTopicRef: "finish the deployment doc",
} as const;

describe("mapProactiveRecallOutcome", () => {
  it("withholds with recall_timeout and records a diagnostic on timeout (Req 2.3)", () => {
    const outcome = mapProactiveRecallOutcome({ status: "timeout" }, { nowMs });

    expect(outcome.kind).toBe("withhold");
    if (outcome.kind !== "withhold") {
      throw new Error("expected withhold");
    }
    expect(outcome.reason).toBe("recall_timeout");
    expect(outcome.diagnostics).toBeDefined();
    expect(outcome.diagnostics?.entries.length).toBeGreaterThan(0);
    expect(outcome.diagnostics?.entries[0]?.ts).toBe(FIXED_NOW_MS);
    expect(outcome.diagnostics?.summary).toContain(`${PROACTIVE_RECALL_TIMEOUT_MS}ms`);
  });

  it("withholds with recall_error and records a diagnostic on error (Req 2.4)", () => {
    const outcome = mapProactiveRecallOutcome(
      { status: "error", error: new Error("index unavailable") },
      { nowMs },
    );

    expect(outcome.kind).toBe("withhold");
    if (outcome.kind !== "withhold") {
      throw new Error("expected withhold");
    }
    expect(outcome.reason).toBe("recall_error");
    expect(outcome.diagnostics).toBeDefined();
    expect(outcome.diagnostics?.entries.length).toBeGreaterThan(0);
    expect(outcome.diagnostics?.entries[0]?.ts).toBe(FIXED_NOW_MS);
    expect(outcome.diagnostics?.summary).toContain("index unavailable");
  });

  it("withholds with recall_empty and records a diagnostic on empty context (Req 2.5)", () => {
    const outcome = mapProactiveRecallOutcome({ status: "ok", details: [] }, { nowMs });

    expect(outcome.kind).toBe("withhold");
    if (outcome.kind !== "withhold") {
      throw new Error("expected withhold");
    }
    expect(outcome.reason).toBe("recall_empty");
    expect(outcome.diagnostics).toBeDefined();
    expect(outcome.diagnostics?.entries.length).toBeGreaterThan(0);
    expect(outcome.diagnostics?.entries[0]?.ts).toBe(FIXED_NOW_MS);
  });

  it("proceeds carrying the recalled details when recall is non-empty (Req 2.6)", () => {
    const details = [makeDetail("You mentioned wanting to finish the deployment doc")];
    const outcome = mapProactiveRecallOutcome({ status: "ok", details }, { nowMs });

    expect(outcome.kind).toBe("proceed");
    if (outcome.kind !== "proceed") {
      throw new Error("expected proceed");
    }
    expect(outcome.details).toEqual(details);
    expect(outcome.details.length).toBeGreaterThan(0);
  });
});

describe("performProactiveRecall with an injected recall fn", () => {
  it("maps a timeout attempt to a recall_timeout withhold (Req 2.3)", async () => {
    const outcome = await performProactiveRecall({
      ...RECALL_PARAMS,
      recall: recallReturning({ status: "timeout" }),
      nowMs,
    });

    expect(outcome.kind).toBe("withhold");
    if (outcome.kind !== "withhold") {
      throw new Error("expected withhold");
    }
    expect(outcome.reason).toBe("recall_timeout");
    expect(outcome.diagnostics).toBeDefined();
  });

  it("maps an error attempt to a recall_error withhold (Req 2.4)", async () => {
    const outcome = await performProactiveRecall({
      ...RECALL_PARAMS,
      recall: recallReturning({ status: "error", error: new Error("recall boom") }),
      nowMs,
    });

    expect(outcome.kind).toBe("withhold");
    if (outcome.kind !== "withhold") {
      throw new Error("expected withhold");
    }
    expect(outcome.reason).toBe("recall_error");
    expect(outcome.diagnostics?.summary).toContain("recall boom");
  });

  it("maps an empty ok attempt to a recall_empty withhold (Req 2.5)", async () => {
    const outcome = await performProactiveRecall({
      ...RECALL_PARAMS,
      recall: recallReturning({ status: "ok", details: [] }),
      nowMs,
    });

    expect(outcome.kind).toBe("withhold");
    if (outcome.kind !== "withhold") {
      throw new Error("expected withhold");
    }
    expect(outcome.reason).toBe("recall_empty");
    expect(outcome.diagnostics).toBeDefined();
  });

  it("maps a non-empty ok attempt to a proceed carrying the details (Req 2.6)", async () => {
    const details = [
      makeDetail("finish the deployment doc"),
      makeDetail("open question about the rollout window"),
    ];
    const outcome = await performProactiveRecall({
      ...RECALL_PARAMS,
      recall: recallReturning({ status: "ok", details }),
      nowMs,
    });

    expect(outcome.kind).toBe("proceed");
    if (outcome.kind !== "proceed") {
      throw new Error("expected proceed");
    }
    expect(outcome.details).toEqual(details);
  });

  it("passes the recall params through to the injected recall fn", async () => {
    let seen: Parameters<ProactiveRecallFn>[0] | undefined;
    const recall: ProactiveRecallFn = async (params) => {
      seen = params;
      return { status: "ok", details: [makeDetail("detail")] };
    };

    await performProactiveRecall({ ...RECALL_PARAMS, recall, nowMs });

    expect(seen?.agentId).toBe(RECALL_PARAMS.agentId);
    expect(seen?.sessionKey).toBe(RECALL_PARAMS.sessionKey);
    expect(seen?.pendingTopicRef).toBe(RECALL_PARAMS.pendingTopicRef);
  });
});
