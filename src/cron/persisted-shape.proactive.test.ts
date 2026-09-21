// Example coverage for the proactiveCheckIn payload kind and the optional
// live `proactive` state block validated by persisted-shape. A malformed row
// here must quarantine (invalid-payload / invalid-state) rather than load and
// crash occurrence evaluation. Requirements: 1.1, 4.7.
import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

function proactiveCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    schedule: { kind: "every", everyMs: 3_600_000 },
    payload: {
      kind: "proactiveCheckIn",
      pendingTopicRef: "topic-deploy-doc",
      targetUser: "user-1",
      deliveryChannel: "discord",
    },
    sessionTarget: "main",
    ...overrides,
  };
}

function withPayload(fields: Record<string, unknown>) {
  return proactiveCandidate({
    payload: {
      kind: "proactiveCheckIn",
      pendingTopicRef: "topic-deploy-doc",
      targetUser: "user-1",
      deliveryChannel: "discord",
      ...fields,
    },
  });
}

describe("persisted cron proactiveCheckIn payload", () => {
  it("accepts a well-formed proactiveCheckIn row", () => {
    expect(getInvalidPersistedCronJobReason(proactiveCandidate())).toBeNull();
  });

  it("quarantines rows missing pendingTopicRef", () => {
    expect(
      getInvalidPersistedCronJobReason(
        proactiveCandidate({
          payload: {
            kind: "proactiveCheckIn",
            targetUser: "user-1",
            deliveryChannel: "discord",
          },
        }),
      ),
    ).toBe("invalid-payload");
    expect(getInvalidPersistedCronJobReason(withPayload({ pendingTopicRef: "  " }))).toBe(
      "invalid-payload",
    );
  });

  it("quarantines rows missing targetUser", () => {
    expect(
      getInvalidPersistedCronJobReason(
        proactiveCandidate({
          payload: {
            kind: "proactiveCheckIn",
            pendingTopicRef: "topic-deploy-doc",
            deliveryChannel: "discord",
          },
        }),
      ),
    ).toBe("invalid-payload");
    expect(getInvalidPersistedCronJobReason(withPayload({ targetUser: "" }))).toBe(
      "invalid-payload",
    );
  });

  it("quarantines rows missing deliveryChannel", () => {
    expect(
      getInvalidPersistedCronJobReason(
        proactiveCandidate({
          payload: {
            kind: "proactiveCheckIn",
            pendingTopicRef: "topic-deploy-doc",
            targetUser: "user-1",
          },
        }),
      ),
    ).toBe("invalid-payload");
    expect(getInvalidPersistedCronJobReason(withPayload({ deliveryChannel: "\t" }))).toBe(
      "invalid-payload",
    );
  });
});

describe("persisted cron proactive state block", () => {
  it("accepts a row with no proactive state block (legacy rows)", () => {
    expect(getInvalidPersistedCronJobReason(proactiveCandidate({ state: {} }))).toBeNull();
    expect(getInvalidPersistedCronJobReason(proactiveCandidate())).toBeNull();
  });

  it("accepts a well-formed proactive state block", () => {
    expect(
      getInvalidPersistedCronJobReason(
        proactiveCandidate({
          state: {
            proactive: {
              resolutionState: "pending",
              unansweredCount: 0,
              lastOpeningMessageAtMs: 1_700_000_000_000,
              lastUserResponseAtMs: 1_700_000_500_000,
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects a proactive block with an unknown resolutionState", () => {
    expect(
      getInvalidPersistedCronJobReason(
        proactiveCandidate({
          state: { proactive: { resolutionState: "done", unansweredCount: 0 } },
        }),
      ),
    ).toBe("invalid-state");
  });

  it("rejects a proactive block with a non-integer or negative unansweredCount", () => {
    expect(
      getInvalidPersistedCronJobReason(
        proactiveCandidate({
          state: { proactive: { resolutionState: "pending", unansweredCount: -1 } },
        }),
      ),
    ).toBe("invalid-state");
    expect(
      getInvalidPersistedCronJobReason(
        proactiveCandidate({
          state: { proactive: { resolutionState: "pending", unansweredCount: 1.5 } },
        }),
      ),
    ).toBe("invalid-state");
  });

  it("rejects a proactive block with a malformed optional timestamp", () => {
    expect(
      getInvalidPersistedCronJobReason(
        proactiveCandidate({
          state: {
            proactive: {
              resolutionState: "pending",
              unansweredCount: 0,
              lastOpeningMessageAtMs: -5,
            },
          },
        }),
      ),
    ).toBe("invalid-state");
  });

  it("rejects a non-object proactive block", () => {
    expect(
      getInvalidPersistedCronJobReason(proactiveCandidate({ state: { proactive: "pending" } })),
    ).toBe("invalid-state");
    expect(getInvalidPersistedCronJobReason(proactiveCandidate({ state: { proactive: [] } }))).toBe(
      "invalid-state",
    );
  });
});
