import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionGroupMembership } from "./session-group-membership.read.js";
import { createSessionRowProjection } from "./session-row-projection.js";

function observeQueries(prototype: StatementSync) {
  const executed: string[] = [];
  const spies = (["all", "get", "iterate"] as const).map((method) => {
    const original = prototype[method];
    return vi.spyOn(prototype, method).mockImplementation(
      new Proxy(original, {
        apply(target, receiver: StatementSync, args) {
          executed.push(receiver.sourceSQL);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
  });
  return { executed, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

it("publishes byte-identical group and participant facts without membership SQL during row refresh or 50 viewer reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:projected-members" };
    await upsertSessionEntryCore(scope, {
      sessionId: "projected-members",
      updatedAt: 1,
      category: " Work ",
    });
    addSessionMember(scope, { identityId: "viewer", addedBy: "owner", addedAt: 1 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "research" }, promptedAt: 2 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "main" }, promptedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    try {
      await projection.ensureMaterialized();
      const nativeEntry = loadSessionEntry(scope);
      expect(
        JSON.stringify({
          participants: projection.describe(query)?.entry.participants,
          participantCount: projection.describe(query)?.entry.participantCount,
        }),
      ).toBe(
        JSON.stringify({
          participants: nativeEntry?.participants,
          participantCount: nativeEntry?.participantCount,
        }),
      );
      const goldenGroups = JSON.stringify([
        ...new Map(readSessionGroupMembership({}, process.env).groups),
      ]);
      const goldenParticipants = JSON.stringify(projection.snapshot(query).row?.participants);
      expect(projection.describe(query)?.membership.has("viewer")).toBe(true);
      const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      const reads = observeQueries(prototype);
      try {
        for (let viewer = 0; viewer < 50; viewer++) {
          expect(JSON.stringify([...projection.sessionGroupTargets()])).toBe(goldenGroups);
          expect(JSON.stringify(projection.snapshot(query).row?.participants)).toBe(
            goldenParticipants,
          );
          expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(true);
        }
        expect(
          reads.executed.filter((sql) => /\bsession_(members|participants)\b/i.test(sql)),
        ).toEqual([]);
      } finally {
        reads.restore();
      }
      // Revocation is visible before full-row materialization or another awaited worker read.
      removeSessionMember(scope, "viewer");
      expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(false);
      const refreshReads = observeQueries(prototype);
      try {
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        expect(projection.describe(query)?.membership.has("viewer")).toBe(false);
        expect(JSON.stringify(projection.snapshot(query).row?.participants)).toBe(
          goldenParticipants,
        );
        expect(
          refreshReads.executed.filter((sql) => /\bsession_(members|participants)\b/i.test(sql)),
        ).toEqual([]);
      } finally {
        refreshReads.restore();
      }
    } finally {
      projection.dispose();
    }
  });
});
