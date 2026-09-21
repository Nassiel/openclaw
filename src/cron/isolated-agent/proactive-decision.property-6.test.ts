// Property coverage for recall-gap withholding and recalled-detail referencing.
//
// Feature: proactive-conversations, Property 6: Recall gaps withhold rather than
// misfire.
//
// The repo intentionally does not pull in `fast-check` (see
// src/cron/proactive/guardrails.property-8.test.ts and
// src/cron/proactive/resolution-state.property-3.test.ts); this file follows the
// same established convention: a small deterministic PRNG (mulberry32) plus
// hand-rolled generators drive >=100 iterations, and every failure prints the
// seed-derived input so the counterexample is reproducible.
//
// The property has two halves, mirroring Property 6's two clauses:
//   1. For any recall *withhold* outcome (recall_timeout / recall_error /
//      recall_empty), decideProactiveOutreach withholds — never delivers — with a
//      recall-sourced withhold and no deliverySuppressionReason (recall gaps are
//      diagnostic-only, Req 2.3-2.5).
//   2. For any recall *proceed* outcome carrying >=1 detail, when guardrails
//      allow (no opt-out, no quiet hours, no min-interval block), the decision is
//      deliver and the composed Opening_Message references a specific recalled
//      detail: referencedDetail is one of the recalled hits AND the message text
//      is grounded in that detail's snippet (Req 2.6).
import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import { clampProactiveGuardrailConfig } from "../proactive/guardrails.js";
import type { ProactiveGuardrailState } from "../proactive/guardrails.js";
import type { ProactiveGuardrailConfig } from "../types.js";
import { decideProactiveOutreach } from "./proactive-decision.js";
import type { ProactiveRecallOutcome, ProactiveRecallWithholdReason } from "./proactive-recall.js";

/** Minimum property iterations required by the design (>= 100). */
const ITERATIONS = 300;

/** Deterministic 32-bit PRNG (mulberry32). */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, loInclusive: number, hiInclusive: number): number {
  return Math.floor(rng() * (hiInclusive - loInclusive + 1)) + loInclusive;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[randInt(rng, 0, items.length - 1)]!;
}

const RECALL_WITHHOLD_REASONS: readonly ProactiveRecallWithholdReason[] = [
  "recall_timeout",
  "recall_error",
  "recall_empty",
];

const CHANNELS = ["slack", "discord", "telegram", "email", "sms"] as const;

/**
 * Snippet fragments biased to exercise the composition normalizer: plain text,
 * whitespace-heavy strings (collapsed to single spaces), an empty snippet (the
 * fallback-to-topic-ref branch), and a long snippet (truncated with an ellipsis).
 */
const SNIPPET_FRAGMENTS = [
  "finish the deployment doc",
  "review the migration plan",
  "  extra   whitespace   around   words  ",
  "",
  "reticulating splines ".repeat(40),
  "call the vendor about the invoice",
] as const;

/** Generate one plausible recalled hit; score varies so detail ranking is exercised. */
function arbitraryDetail(rng: () => number): MemorySearchResult {
  const startLine = randInt(rng, 1, 500);
  return {
    path: `sessions/topic-${randInt(rng, 0, 9999)}.md`,
    startLine,
    endLine: startLine + randInt(rng, 0, 20),
    score: randInt(rng, -50, 100) / 10,
    snippet: pick(rng, SNIPPET_FRAGMENTS),
    source: rng() < 0.5 ? "memory" : "sessions",
  };
}

function arbitraryDetails(rng: () => number): MemorySearchResult[] {
  const count = randInt(rng, 1, 6);
  const details: MemorySearchResult[] = [];
  for (let i = 0; i < count; i += 1) {
    details.push(arbitraryDetail(rng));
  }
  return details;
}

/**
 * A guardrail config + state pair that deterministically ALLOWS: no quiet hours
 * and no prior opening message, so opt-out (forced false), quiet-hours, and
 * min-interval all pass. minIntervalSeconds/maxUnanswered vary within range.
 */
function allowingGuardrails(rng: () => number): {
  guardrails: ProactiveGuardrailConfig;
  state: ProactiveGuardrailState;
} {
  return {
    guardrails: clampProactiveGuardrailConfig({
      minIntervalSeconds: randInt(rng, 900, 86_400),
      maxUnanswered: randInt(rng, 1, 10),
    }),
    // No lastOpeningMessageAtMs => min-interval branch cannot fire.
    state: {},
  };
}

describe("Feature: proactive-conversations, Property 6", () => {
  // Property 6: Recall gaps withhold rather than misfire.
  // Validates: Requirements 2.3, 2.4, 2.5, 2.6

  it("withholds (never delivers) for any recall withhold outcome, with a recall source and no suppression reason", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x60_00_00 + i;
      const rng = makeRng(seed);

      const reason = pick(rng, RECALL_WITHHOLD_REASONS);
      const recall: ProactiveRecallOutcome = {
        kind: "withhold",
        reason,
        diagnostics: {
          summary: `proactive recall ${reason}`,
          entries: [
            {
              ts: randInt(rng, 0, 4_000_000_000_000),
              source: "cron-setup",
              severity: "warn",
              message: `proactive recall ${reason}`,
            },
          ],
        },
      };

      const { guardrails, state } = allowingGuardrails(rng);
      const decision = decideProactiveOutreach({
        firingAtMs: randInt(rng, 0, 4_000_000_000_000),
        recall,
        pendingTopicRef: `topic-${randInt(rng, 0, 9999)}`,
        targetUser: `user-${randInt(rng, 0, 9999)}`,
        deliveryChannel: pick(rng, CHANNELS),
        guardrails,
        state,
        // Even with opt-out forced OFF and guardrails permissive, a recall gap
        // must still withhold: the recall branch is evaluated before guardrails.
        resolveOptedOut: () => false,
      });

      const label = `seed=${seed} reason=${reason} decision=${JSON.stringify(decision)}`;

      // A recall gap never misfires an outreach.
      expect(decision.kind, `${label} (never deliver)`).toBe("withhold");
      if (decision.kind !== "withhold") {
        continue;
      }
      // The withhold is attributed to recall, carrying the exact recall reason.
      expect(decision.source.kind, `${label} (recall source)`).toBe("recall");
      expect(decision.source, `${label} (recall reason)`).toEqual({ kind: "recall", reason });
      // Recall gaps are diagnostic-only: no deliverySuppressionReason (Req 2.3-2.5,
      // distinct from guardrail withholds which do carry one).
      expect(
        decision.deliverySuppressionReason,
        `${label} (no suppression reason)`,
      ).toBeUndefined();
      // The recall diagnostics are carried through for the run to record.
      expect(decision.diagnostics, `${label} (diagnostics carried)`).toBe(recall.diagnostics);
    }
  });

  it("delivers a message that references a specific recalled detail whenever recall proceeds and guardrails allow", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x61_00_00 + i;
      const rng = makeRng(seed);

      const details = arbitraryDetails(rng);
      const recall: ProactiveRecallOutcome = { kind: "proceed", details };
      const pendingTopicRef = `topic-${randInt(rng, 0, 9999)}`;
      const deliveryChannel = pick(rng, CHANNELS);
      const { guardrails, state } = allowingGuardrails(rng);

      const decision = decideProactiveOutreach({
        firingAtMs: randInt(rng, 0, 4_000_000_000_000),
        recall,
        pendingTopicRef,
        targetUser: `user-${randInt(rng, 0, 9999)}`,
        deliveryChannel,
        guardrails,
        state,
        resolveOptedOut: () => false,
      });

      const label = `seed=${seed} details=${JSON.stringify(details)} decision=${JSON.stringify(decision)}`;

      // A permissive guardrail path with non-empty recall always delivers.
      expect(decision.kind, `${label} (delivers)`).toBe("deliver");
      if (decision.kind !== "deliver") {
        continue;
      }
      const message = decision.message;

      // The message is delivered through the requested real channel.
      expect(message.deliveryChannel, `${label} (channel)`).toBe(deliveryChannel);

      // referencedDetail is one of the actual recalled hits (Req 2.6): the
      // outreach is grounded in recalled context, not invented.
      expect(details, `${label} (referenced is a recalled detail)`).toContain(
        message.referencedDetail,
      );

      // The full recalled set is carried through for richer grounding.
      expect(message.recalledDetails, `${label} (recalled carried)`).toBe(details);

      // The composed text is grounded in the referenced detail (Req 2.6): when
      // the referenced snippet has content, the message echoes it; when the
      // snippet is blank, it falls back to naming the pending topic. Either way
      // the text is non-empty and tied to the specific recalled detail.
      const snippet = message.referencedDetail.snippet;
      const collapsed = snippet.replace(/\s+/gu, " ").trim();
      expect(message.text.length, `${label} (non-empty text)`).toBeGreaterThan(0);
      if (collapsed.length > 0) {
        // A prefix of the referenced snippet appears verbatim in the message so
        // the outreach references that specific recalled detail.
        const groundingPrefix = collapsed.slice(0, Math.min(collapsed.length, 32));
        expect(message.text, `${label} (grounded in snippet)`).toContain(groundingPrefix);
      } else {
        // Blank snippet => the fallback references the pending topic instead.
        expect(message.text, `${label} (grounded in topic ref)`).toContain(pendingTopicRef);
      }
    }
  });
});
