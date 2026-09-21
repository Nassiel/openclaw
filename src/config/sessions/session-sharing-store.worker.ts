import type { DatabaseSync } from "node:sqlite";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSqliteSessionParticipantProjection } from "./session-accessor.sqlite-participant-projection.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  applySessionGroupCategoryMutation,
  assertSessionGroupCategoryDestination,
  prepareSessionGroupCategoryMutation,
} from "./session-group-categories.kernel.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";

type MembershipPublication = { membership: string[] };
type ParticipantPublication = {
  projectionChanged: boolean;
  participants: ReturnType<typeof readSqliteSessionParticipantProjection>;
};

export type SessionSharingWorkerOperations = {
  "category.prepare": { input: { scope: SessionAccessScope; from: string }; output: string[] };
  "category.apply": {
    input: { scope: SessionAccessScope; from: string; to?: string };
    output: string[];
  };
  add: {
    input: { scope: SessionAccessScope; params: Parameters<typeof addSessionMember>[1] };
    output: { value: ReturnType<typeof addSessionMember> } & MembershipPublication;
  };
  remove: {
    input: {
      scope: SessionAccessScope;
      identityId: string;
      expected?: Parameters<typeof removeSessionMember>[2];
      expectedSessionId?: string;
      expectedEntry?: Parameters<typeof removeSessionMember>[4];
    };
    output: { value: ReturnType<typeof removeSessionMember> } & MembershipPublication;
  };
  participant: {
    input: { scope: SessionAccessScope; params: Parameters<typeof recordSessionParticipant>[1] };
    output: { value: ReturnType<typeof recordSessionParticipant> } & ParticipantPublication;
  };
};

/** The canonical agent executor retains the connection and both live admission checks. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<SessionSharingWorkerOperations> {
  const db = context.database;
  let categoryPlan:
    | {
        from: string;
        storePath: string;
        rows: ReturnType<typeof prepareSessionGroupCategoryMutation>;
      }
    | undefined;
  const categoryDatabase = (scope: SessionAccessScope) => {
    const database = getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(resolveSqliteScope(scope)));
    if (!database || database.db !== db || database.path !== context.databasePath) {
      throw new Error("Session group category write lost its physical store owner");
    }
    return database;
  };
  return {
    execute(command) {
      if (command.type === "category.prepare") {
        const database = categoryDatabase(command.input.scope);
        return withSqlitePostCommitPublications(db, () =>
          runSqliteDeferredTransactionSync(db, () => {
            categoryPlan = {
              from: command.input.from,
              storePath: database.path,
              rows: prepareSessionGroupCategoryMutation(database, command.input.from),
            };
            return [...categoryPlan.rows.keys()];
          }),
        );
      }
      let participantResult: SessionSharingWorkerOperations["participant"]["output"] | undefined;
      const unsubscribe =
        command.type === "participant"
          ? sessionChanges.subscribe((change) => {
              if (
                participantResult &&
                "sessionKey" in change &&
                change.sessionKey === command.input.scope.sessionKey &&
                change.storePath === context.databasePath
              ) {
                participantResult.projectionChanged = true;
              }
            })
          : undefined;
      try {
        return withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
              context.admit("transaction");
              const scope = command.input.scope;
              if (command.type === "category.apply") {
                const database = categoryDatabase(scope);
                if (
                  !categoryPlan ||
                  categoryPlan.from !== command.input.from ||
                  categoryPlan.storePath !== database.path
                ) {
                  throw new Error("Session group category mutation has no matching prepared rows");
                }
                return applySessionGroupCategoryMutation(
                  database,
                  categoryPlan.rows,
                  command.input.to,
                  scope.env ?? process.env,
                );
              }
              if (command.type === "participant") {
                const value = recordSessionParticipant(scope, command.input.params);
                participantResult = {
                  value,
                  projectionChanged: false,
                  participants: readSqliteSessionParticipantProjection(db, scope.sessionKey),
                };
                return participantResult;
              }
              if (command.type === "add") {
                const value = addSessionMember(scope, command.input.params);
                return {
                  value,
                  membership: listSessionMembersInDatabase({ db }, scope.sessionKey).map(
                    (member) => member.identityId,
                  ),
                };
              }
              const value = removeSessionMember(
                scope,
                command.input.identityId,
                command.input.expected,
                command.input.expectedSessionId,
                command.input.expectedEntry,
              );
              return {
                value,
                membership: listSessionMembersInDatabase({ db }, scope.sessionKey).map(
                  (member) => member.identityId,
                ),
              };
            },
            {
              operationLabel: `sessions.${command.type}`,
              busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
              databaseLabel: context.databasePath,
              withCommit(commit) {
                context.admit("commit");
                if (command.type === "category.apply") {
                  assertSessionGroupCategoryDestination(
                    command.input.to,
                    command.input.scope.env ?? process.env,
                  );
                }
                commit();
              },
            },
          ),
        );
      } finally {
        unsubscribe?.();
      }
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Session collaboration transaction did not settle");
      }
    },
    close() {},
  };
}
