/**
 * Example tests for the ordered create-time validation of the `proactiveCheckIn`
 * cron payload (Task 8.2). These exercise the pure
 * {@link validateProactiveCheckInCreate} helper directly so they stay runtime-free
 * per src/agents/tools/AGENTS.md and src/agents/AGENTS.md: no channel/plugin
 * runtime is cold-loaded, only the shared pure channel classifiers the helper
 * already depends on.
 *
 * Each rejection path is a distinct create error the design names (Req 1.3-1.6,
 * 3.2). Because validation throws before any `cron.add`, atomicity is proven by
 * asserting the helper throws (no job object is ever produced); the success path
 * returns the resolved channel that the caller stamps onto a `pending` job.
 */
import { describe, expect, it } from "vitest";
import { validateProactiveCheckInCreate } from "./cron-tool-proactive-create.js";

/** A real, user-facing bundled Delivery_Channel id used for the success path. */
const REAL_CHANNEL = "telegram";

/** Builds a fully valid normalized proactive job; tests override single fields. */
function makeValidJob(
  overrides: {
    schedule?: unknown;
    payload?: Record<string, unknown>;
    delivery?: unknown;
  } = {},
): Record<string, unknown> {
  // Use `in` checks so an explicit `undefined` override clears a field rather
  // than falling back to the valid default (which would mask the ordering).
  const schedule =
    "schedule" in overrides ? overrides.schedule : { kind: "every", everyMs: 3_600_000 };
  const payload: Record<string, unknown> = {
    kind: "proactiveCheckIn",
    pendingTopicRef: "topic-deploy-doc",
    deliveryChannel: REAL_CHANNEL,
    ...(overrides.payload ?? {}),
  };
  return {
    id: "proactive-1",
    schedule,
    payload,
    ...("delivery" in overrides ? { delivery: overrides.delivery } : {}),
  };
}

describe("validateProactiveCheckInCreate", () => {
  describe("schedule form (Req 1.3)", () => {
    it("rejects a missing schedule form and names it", () => {
      const job = makeValidJob({ schedule: undefined });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/schedule form/);
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/none/);
    });

    it("rejects an unsupported schedule form and names the invalid form", () => {
      const job = makeValidJob({ schedule: { kind: "weekly" } });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/schedule form/);
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/"weekly"/);
    });

    it.each(["at", "every", "cron"] as const)("accepts the supported schedule form %s", (kind) => {
      const job = makeValidJob({ schedule: { kind } });
      expect(validateProactiveCheckInCreate({ job })).toEqual({
        deliveryChannel: REAL_CHANNEL,
      });
    });
  });

  describe("pending topic (Req 1.6)", () => {
    it("rejects a missing pendingTopicRef and names the missing topic", () => {
      const job = makeValidJob({ payload: { pendingTopicRef: undefined } });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/pendingTopicRef/);
    });

    it("rejects a blank pendingTopicRef", () => {
      const job = makeValidJob({ payload: { pendingTopicRef: "   " } });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/pendingTopicRef/);
    });
  });

  describe("delivery channel presence (Req 1.4)", () => {
    it("rejects when no channel is supplied and none can be inferred", () => {
      const job = makeValidJob({ payload: { deliveryChannel: undefined } });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/requires a delivery channel/);
    });

    it("uses the inferred channel when the payload omits one", () => {
      const job = makeValidJob({ payload: { deliveryChannel: undefined } });
      expect(
        validateProactiveCheckInCreate({ job, inferredDeliveryChannel: REAL_CHANNEL }),
      ).toEqual({ deliveryChannel: REAL_CHANNEL });
    });
  });

  describe("unresolvable / internal channel (Req 1.5, 3.2)", () => {
    it("rejects the internal non-delivery cron channel with the distinct channel error", () => {
      const job = makeValidJob({ payload: { deliveryChannel: "cron" } });
      // Distinct from the missing-channel error: names the unresolvable channel,
      // not "requires a delivery channel".
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(
        /"cron" is not a real user-facing channel/,
      );
      expect(() => validateProactiveCheckInCreate({ job })).not.toThrow(
        /requires a delivery channel/,
      );
    });

    it("rejects the internal webchat channel", () => {
      const job = makeValidJob({ payload: { deliveryChannel: "webchat" } });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(
        /"webchat" is not a real user-facing channel/,
      );
    });

    it("rejects an inferred internal cron channel (never delivers through cron)", () => {
      const job = makeValidJob({ payload: { deliveryChannel: undefined } });
      expect(() =>
        validateProactiveCheckInCreate({ job, inferredDeliveryChannel: "cron" }),
      ).toThrow(/"cron" is not a real user-facing channel/);
    });

    it("rejects an unrecognized channel with the distinct channel error", () => {
      const job = makeValidJob({ payload: { deliveryChannel: "no-such-channel" } });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(
        /is not a real user-facing channel/,
      );
    });
  });

  describe("success path (Req 1.1, 1.7)", () => {
    it("returns the resolved real channel for a fully valid job", () => {
      const job = makeValidJob();
      expect(validateProactiveCheckInCreate({ job })).toEqual({
        deliveryChannel: REAL_CHANNEL,
      });
    });

    it("prefers the payload channel over an inferred one", () => {
      const job = makeValidJob({ payload: { deliveryChannel: REAL_CHANNEL } });
      expect(validateProactiveCheckInCreate({ job, inferredDeliveryChannel: "discord" })).toEqual({
        deliveryChannel: REAL_CHANNEL,
      });
    });

    it("reads the channel from the delivery block when the payload omits one", () => {
      const job = makeValidJob({
        payload: { deliveryChannel: undefined },
        delivery: { channel: REAL_CHANNEL },
      });
      expect(validateProactiveCheckInCreate({ job })).toEqual({
        deliveryChannel: REAL_CHANNEL,
      });
    });
  });

  describe("ordered atomic rejection", () => {
    it("reports the schedule error first when multiple fields are invalid", () => {
      // Schedule check runs before topic and channel checks; an all-invalid job
      // surfaces the schedule error, and nothing downstream runs.
      const job = makeValidJob({
        schedule: undefined,
        payload: { pendingTopicRef: undefined, deliveryChannel: undefined },
      });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/schedule form/);
    });

    it("reports the topic error before the channel error", () => {
      const job = makeValidJob({
        payload: { pendingTopicRef: undefined, deliveryChannel: undefined },
      });
      expect(() => validateProactiveCheckInCreate({ job })).toThrow(/pendingTopicRef/);
    });
  });
});
