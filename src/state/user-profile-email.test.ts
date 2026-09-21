import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { ensureProfileIdForEmail } from "./user-profile-email.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { readUserProfileEmailBindings } from "./user-profile-identity.read.js";
import {
  prepareUserProfileIdentity,
  readResidentUserProfileId,
  retainUserProfileCatalog,
} from "./user-profile-list.js";
import { ensureProfileForEmail, linkEmail } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({ afterResult: undefined as (() => void) | undefined }));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "userProfiles.email.ensure") {
                delivery.afterResult?.();
              }
              return result;
            },
          }),
        options,
      ),
  };
});
afterEach(() => {
  delivery.afterResult = undefined;
});

it("publishes a created email profile after lost result delivery while its database closes", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const pathname = openOpenClawStateDatabase().path;
    const existing = ensureProfileForEmail("existing@example.test");
    const prepared = await prepareUserProfileIdentity(existing.id);
    const release = retainUserProfileCatalog();
    let closing: ReturnType<typeof closeOpenClawStateDatabaseByPathAsync> | undefined;
    try {
      const before = readUserProfileVersion();
      delivery.afterResult = () => {
        closing = closeOpenClawStateDatabaseByPathAsync(pathname);
        throw new Error("synthetic profile result loss");
      };
      await expect(ensureProfileIdForEmail("new@example.test")).rejects.toThrow(
        "synthetic profile result loss",
      );
      await closing;
      const profile = ensureProfileForEmail("new@example.test");
      expect(readResidentUserProfileId(profile.id)).toBe(profile.id);
      expect(readUserProfileVersion()).toBe(before + 1);
      const created = await prepareUserProfileIdentity(profile.id);
      try {
        expect(created.emailBindingIds).toEqual([expect.any(String)]);
        expect(() => created.assertCurrent(created.emailBindingIds)).not.toThrow();
      } finally {
        created.release();
      }
    } finally {
      await closing;
      release();
      prepared.release();
    }
  });
});

it("does not restore an old binding from a creation reply delivered after alias reassignment", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const target = ensureProfileForEmail("target@example.test");
    const retained = await prepareUserProfileIdentity(target.id);
    let originalBinding: string | null | undefined;
    try {
      delivery.afterResult = () => {
        const created = ensureProfileForEmail("delayed@example.test");
        originalBinding = readUserProfileEmailBindings(
          openOpenClawStateDatabase().db,
          created.id,
        )[0]?.bindingId;
        linkEmail("retained@example.test", created.id);
        linkEmail("delayed@example.test", target.id);
        linkEmail("delayed@example.test", created.id);
      };
      const profileId = await ensureProfileIdForEmail("delayed@example.test");
      expect(originalBinding).toEqual(expect.any(String));
      const current = await prepareUserProfileIdentity(profileId);
      try {
        expect(current.emailBindingIds).toHaveLength(2);
        expect(current.emailBindingIds).not.toContain(originalBinding);
        expect(() => current.assertCurrent([originalBinding!])).toThrow("user profile not found");
        expect(() => current.assertCurrent(current.emailBindingIds)).not.toThrow();
      } finally {
        current.release();
      }
    } finally {
      retained.release();
    }
  });
});
