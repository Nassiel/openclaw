import type { SessionCostUsageCacheReadResult } from "../../infra/session-cost-usage-cache-read.js";
import type { SessionHistoryWorkerResult } from "./session-history-types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { SessionStoreTargetInventoryResult } from "./session-store-target-inventory.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionPreviewWorkerInput,
  SessionPreviewWorkerResult,
  SessionTitleFieldsWorkerInput,
  SessionTitleFieldsWorkerResult,
  SessionTranscriptSearchWorkerInput,
  SessionTranscriptSearchWorkerResult,
  SessionIdentityEvidenceWorkerInput,
  SessionIdentityEvidenceWorkerResult,
  SessionTranscriptHistoryWorkerInput,
  SessionEntryListWorkerInput,
  SessionEntryListWorkerResult,
  SessionRowPresenceWorkerInput,
  SessionMembersWorkerInput,
  SessionUsageCacheWorkerInput,
  SessionTranscriptHydrationWorkerInput,
} from "./session-transcript-worker.types.js";

export type SessionHistoryWorkerRequestRunner = <TResult>(
  prepare: () =>
    | Omit<SessionTranscriptHistoryWorkerInput, "database">
    | Omit<SessionPreviewWorkerInput, "database">
    | Omit<SessionTitleFieldsWorkerInput, "database">
    | Omit<SessionTranscriptSearchWorkerInput, "database">
    | Omit<SessionRowPresenceWorkerInput, "database">
    | Omit<SessionEntryListWorkerInput, "database">
    | Omit<SessionIdentityEvidenceWorkerInput, "database">
    | Omit<SessionMembersWorkerInput, "database">
    | Omit<SessionUsageCacheWorkerInput, "database">
    | Omit<SessionTranscriptHydrationWorkerInput, "database">,
  inputBytes: number,
  receive: (
    value:
      | SessionHistoryWorkerResult
      | SessionPreviewWorkerResult
      | SessionTitleFieldsWorkerResult
      | SessionTranscriptSearchWorkerResult
      | boolean
      | SessionEntryListWorkerResult
      | SessionIdentityEvidenceWorkerResult
      | SessionStoreTargetInventoryResult
      | SessionMember[]
      | SessionCostUsageCacheReadResult
      | PreparedSessionTranscriptHydration,
  ) => TResult,
) => Promise<TResult>;

/** Decode domain results; database custody remains with the enclosing history owner. */
export function createSessionHistoryWorkerReaders(runRequest: SessionHistoryWorkerRequestRunner) {
  return {
    searchTranscripts: async (params: SessionTranscriptSearchWorkerInput["params"]) =>
      await runRequest(
        () => ({ kind: "transcript-search", params }),
        JSON.stringify(params).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "transcript-search"
          ) {
            throw new Error("Session history worker returned another result instead of search");
          }
          return value.result;
        },
      ),
    readPreview: async (input: Omit<SessionPreviewWorkerInput, "kind" | "database">) =>
      await runRequest(
        () => ({ kind: "session-preview", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-preview"
          ) {
            throw new Error("Session history worker returned another result instead of a preview");
          }
          return value.items;
        },
      ),
    readTitleFields: async (input: Omit<SessionTitleFieldsWorkerInput, "kind" | "database">) =>
      await runRequest(
        () => ({ kind: "session-title-fields", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-title-fields"
          ) {
            throw new Error(
              "Session history worker returned another result instead of title fields",
            );
          }
          return value.fields;
        },
      ),
    run: async (
      prepare: () => Omit<SessionTranscriptHistoryWorkerInput, "database">,
      inputBytes: number,
    ) =>
      await runRequest(prepare, inputBytes, (value) => {
        if (
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (value.kind !== "rpc" &&
            value.kind !== "http" &&
            value.kind !== "delta" &&
            value.kind !== "message-lookup")
        ) {
          throw new Error("Session history worker returned metadata instead of history");
        }
        return value;
      }),
    readTranscript: async (
      input: Omit<SessionTranscriptHydrationWorkerInput, "kind" | "database">,
    ) =>
      await runRequest(
        () => ({ kind: "transcript-hydration", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            (value.kind !== "full" && value.kind !== "bounded")
          ) {
            throw new Error(
              "Session history worker returned another result instead of a transcript",
            );
          }
          return value;
        },
      ),
    readUsageCache: async (input: Omit<SessionUsageCacheWorkerInput, "kind" | "database">) =>
      await runRequest(
        () => ({ kind: "usage-cache", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "usage-refresh-lock"
          ) {
            throw new Error(
              "Session history worker returned another result instead of usage cache",
            );
          }
          return value;
        },
      ),
    readMembers: async (input: Omit<SessionMembersWorkerInput, "kind" | "database">) =>
      await runRequest(
        () => ({ kind: "session-members", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (!Array.isArray(value)) {
            throw new Error("Session history worker returned another result instead of members");
          }
          return value;
        },
      ),
    readEntries: async (scope: SessionEntryListWorkerInput["scope"]) =>
      await runRequest(
        () => ({ kind: "session-entry-list", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-entry-list"
          ) {
            throw new Error("Session history worker returned another result instead of entries");
          }
          return value.entries;
        },
      ),
    readIdentityEvidence: async (
      input: Omit<SessionIdentityEvidenceWorkerInput, "kind" | "database">,
    ) =>
      await runRequest(
        () => ({ kind: "session-identity-evidence", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-identity-evidence"
          ) {
            throw new Error(
              "Session history worker returned another result instead of identity evidence",
            );
          }
          return value.evidence;
        },
      ),
    readEntryPresence: async (scope: SessionRowPresenceWorkerInput["scope"]) =>
      await runRequest(
        () => ({ kind: "session-row-presence", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          if (typeof value !== "boolean") {
            throw new Error("Session history worker returned history instead of metadata presence");
          }
          return value;
        },
      ),
  };
}
