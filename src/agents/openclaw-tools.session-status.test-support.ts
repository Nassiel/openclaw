import { resolveSessionEntryCandidates } from "../config/sessions/store-entry.js";
import { mergeSessionEntry, type SessionEntry } from "../config/sessions/types.js";

export function createSessionStatusStoreMock(params: {
  snapshot: (storePath: string) => Record<string, SessionEntry>;
  replace: (storePath: string, snapshot: Record<string, SessionEntry>) => void;
}) {
  const resolveMockStorePath = (_store: string | undefined, opts?: { agentId?: string }) =>
    opts?.agentId === "support" ? "/tmp/support/sessions.json" : "/tmp/main/sessions.json";
  const cloneEntry = (entry: SessionEntry): SessionEntry => structuredClone(entry);
  const resolveSnapshotEntry = (snapshot: Record<string, SessionEntry>, sessionKey: string) =>
    resolveSessionEntryCandidates({
      entries: Object.entries(snapshot).map(([key, entry]) => ({ sessionKey: key, entry })),
      sessionKey,
    });
  return {
    patchSessionEntryWithKey: async (
      scope: { agentId?: string; sessionKey: string; storePath?: string },
      update: (
        entry: SessionEntry,
        context: { existingEntry?: SessionEntry },
      ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
      options?: { fallbackEntry?: SessionEntry; replaceEntry?: boolean },
    ) => {
      const storePath =
        scope.storePath ?? resolveMockStorePath(undefined, { agentId: scope.agentId });
      const store = params.snapshot(storePath);
      const resolved = resolveSnapshotEntry(store, scope.sessionKey);
      const existing = resolved.existing?.entry ?? options?.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await update(cloneEntry(existing), {
        existingEntry: resolved.existing ? cloneEntry(resolved.existing.entry) : undefined,
      });
      if (!patch) {
        return { sessionKey: resolved.normalizedKey, entry: cloneEntry(existing) };
      }
      const next = options?.replaceEntry
        ? cloneEntry(patch as SessionEntry)
        : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      params.replace(storePath, store);
      return { sessionKey: resolved.normalizedKey, entry: cloneEntry(next) };
    },
    resolveSessionEntryCandidateTarget: (scope: {
      agentId: string;
      candidateKeys: readonly string[];
      cfg: { session?: { store?: string } };
      fallback?: { sessionKey: string; entry: SessionEntry };
    }) => {
      const storePath = resolveMockStorePath(scope.cfg.session?.store, { agentId: scope.agentId });
      const store = params.snapshot(storePath);
      const candidates = [...new Set(scope.candidateKeys.map((key) => key.trim()))];
      for (const candidateKey of candidates) {
        if (!candidateKey) {
          continue;
        }
        const resolved = resolveSnapshotEntry(store, candidateKey);
        if (!resolved.existing) {
          continue;
        }
        return {
          agentId: scope.agentId,
          candidateKey,
          entry: cloneEntry(resolved.existing.entry),
          persisted: true,
          sessionKey: resolved.normalizedKey,
        };
      }
      const fallbackKey = scope.fallback?.sessionKey.trim();
      return fallbackKey && scope.fallback
        ? {
            agentId: scope.agentId,
            candidateKey: fallbackKey,
            entry: cloneEntry(scope.fallback.entry),
            persisted: false,
            sessionKey: fallbackKey,
          }
        : null;
    },
    resolveSessionStorePathCore: resolveMockStorePath,
  };
}
