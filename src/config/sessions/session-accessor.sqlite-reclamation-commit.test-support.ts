import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { reclaimSqliteWalFreePages } from "../../infra/sqlite-wal-reclamation.js";
import {
  markSqliteReclamationSettled,
  waitForSqliteReclamationCommit,
  waitForSqliteReclamationSettlement,
} from "./session-accessor.sqlite-reclamation-commit.js";

type CommitFixture = {
  databasePath: string;
  gate: SharedArrayBuffer;
  progress: SharedArrayBuffer;
  holdAfterApproval?: boolean;
  reclaimPages?: boolean;
  outcome?: "rollback" | "exit-before-commit" | "exit-after-commit";
};

const port = parentPort;
if (!port) {
  throw new Error("commit fixture requires a Worker parent port");
}

const fixture = workerData as CommitFixture;
const progress = new Int32Array(fixture.progress);
const database = openNodeSqliteDatabase(fixture.databasePath);
const authorize = () => {
  waitForSqliteReclamationCommit(fixture.gate, () => port.postMessage("commit-request"));
  Atomics.store(progress, 0, 1);
  Atomics.notify(progress, 0);
  if (fixture.holdAfterApproval) {
    Atomics.wait(progress, 1, 0);
  }
};
try {
  if (fixture.reclaimPages) {
    let checkpoints = 0;
    const reclamation = reclaimSqliteWalFreePages(
      database,
      (mode) => {
        if (++checkpoints === 2 && Atomics.wait(progress, 2, 0, 5_000) === "timed-out") {
          throw new Error("parent did not acquire its settlement barrier");
        }
        const row = database.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
        return row?.busy === 0 && row.log === row.checkpointed;
      },
      {
        maxPages: 7,
        onCommit: authorize,
        onCommitted: () => waitForSqliteReclamationSettlement(fixture.gate),
      },
    );
    port.postMessage({ reclamation, walBytes: fs.statSync(`${fixture.databasePath}-wal`).size });
  } else {
    database.exec("BEGIN IMMEDIATE; UPDATE proof SET value = 2");
    authorize();
    if (fixture.outcome === "exit-before-commit") {
      process.exit(7);
    }
    if (fixture.outcome === "rollback") {
      throw new Error("injected worker transaction failure");
    }
    database.exec("COMMIT");
    if (fixture.outcome === "exit-after-commit") {
      process.exit(9);
    }
    waitForSqliteReclamationSettlement(fixture.gate);
  }
} catch (error) {
  if (database.isTransaction) {
    database.exec("ROLLBACK");
  }
  port.postMessage({ error: String(error) });
} finally {
  database.close();
  markSqliteReclamationSettled(fixture.gate);
  Atomics.store(progress, 0, 2);
  Atomics.notify(progress, 0);
}
