import type { DatabaseSync } from "node:sqlite";
import type { SessionEntry } from "../config/sessions/types.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type SessionRowChange =
  | {
      sessionKey: string;
      agentId?: string;
      storePath?: string;
      scope?: "automation";
      /** Committed replacement facts, installed before synchronous event recipients run. */
      factsInvalidated?: true;
      membership?: readonly string[];
      participants?: Pick<SessionEntry, "participants" | "participantCount">;
    }
  | {
      all: true;
      scope: string | { agentId?: string; storePath?: string };
      factsInvalidated?: true;
    };

const listeners = resolveGlobalSet<(change: SessionRowChange) => void>(
  Symbol.for("openclaw.sessionRowChanges"),
  "close-and-restart",
);

export const sessionChanges = {
  subscribe(listener: (change: SessionRowChange) => void): () => void {
    return registerListener(listeners, listener);
  },
  /** SQLite observers run only after all committed owner state has settled. */
  emit(change: SessionRowChange, database?: DatabaseSync): void {
    const publish = () => notifyListeners(listeners, change);
    if (!database || !deferSqlitePostCommitPublication(database, publish)) {
      publish();
    }
  },
};
