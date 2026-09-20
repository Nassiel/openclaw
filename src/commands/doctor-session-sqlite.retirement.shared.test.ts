// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import * as migrationArtifact from "./doctor-session-sqlite-artifact.js";
import * as migrationRun from "./doctor-session-sqlite-migration-run.js";
import * as sqliteReaders from "./doctor-session-sqlite-readers.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  setupDoctorSessionSqliteTest,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createSharedRecoveryFixture, createVerifiedRecoveryStore } =
  setupDoctorSessionSqliteTest();

describe("runDoctorSessionSqlite", () => {
  it.each(
    [
      { reference: "explicit", sessionFile: "session-1.jsonl" },
      { reference: "default", sessionFile: undefined },
      { reference: "relocated", sessionFile: "/previous-machine/relocated-original.jsonl" },
      {
        reference: "canonical-relocated",
        sessionFile: "/previous-machine/.openclaw/agents/main/sessions/relocated-original.jsonl",
      },
    ].flatMap(({ reference, sessionFile }) =>
      ([1, 2, 3] as const).map((version) => ({ reference, sessionFile, version })),
    ),
  )(
    "preserves index dependencies across an interrupted import retry ($reference, v$version)",
    async ({ sessionFile, version }) => {
      const store = createLegacyStore({
        entryOverrides: { sessionFile },
        transcriptLines: [
          '{"type":"session","id":"session-1","version":3}',
          '{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"retained retry history"}}',
        ],
      });
      const transcriptPath = path.join(
        store.sessionDir,
        path.basename(sessionFile ?? store.transcriptPath),
      );
      if (transcriptPath !== store.transcriptPath) {
        fs.renameSync(store.transcriptPath, transcriptPath);
      }
      const indexBytes = fs.readFileSync(store.storePath);
      const transcriptBytes = fs.readFileSync(transcriptPath);
      let interruptedManifestPath: string | undefined;
      const spy = vi
        .spyOn(migrationRun, "recordCompletedMigrationMoves")
        .mockImplementationOnce((run) => {
          interruptedManifestPath = run?.manifestPath;
          throw new Error("interrupted after transcript publication");
        });
      try {
        await expect(
          runDoctorSessionSqlite({
            env: store.env,
            store: store.storePath,
            mode: "import",
          }),
        ).rejects.toThrow("interrupted after transcript publication");
      } finally {
        spy.mockRestore();
      }
      expect(readMigrationManifest(interruptedManifestPath).completedAt).toBeUndefined();
      expect(fs.existsSync(transcriptPath)).toBe(false);
      expect(fs.readFileSync(store.storePath)).toEqual(indexBytes);
      const retried = await runDoctorSessionSqlite({
        env: store.env,
        store: store.storePath,
        mode: "import",
      });
      expect(retried.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(
        migrationRun.readSessionSqliteMigrationManifest(
          requireMigrationManifestPath(retried.migrationRun?.manifestPath),
        ),
      ).toBeDefined();
      if (version !== 3) {
        for (const runPath of [interruptedManifestPath, retried.migrationRun?.manifestPath]) {
          const manifestPath = requireMigrationManifestPath(runPath);
          const historical = readMigrationManifest(manifestPath);
          historical.manifestVersion = version;
          for (const target of historical.targets) {
            for (const move of [...target.plannedMoves, ...target.completedMoves]) {
              delete move.artifact;
            }
          }
          fs.writeFileSync(manifestPath, JSON.stringify(historical));
        }
      }
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      const manifest = readMigrationManifest(retried.migrationRun?.manifestPath);
      const indexMove = expectDefined(
        manifest.targets[0]?.completedMoves.find((move) => move.kind === "legacy-store"),
        "retry must publish the index",
      );
      expect(fs.existsSync(indexMove.archivePath)).toBe(true);
      expect(retired.totals.removedFiles).toBe(0);
      const restored = await runDoctorSessionSqlite({
        env: store.env,
        store: store.storePath,
        mode: "restore",
      });
      expect(restored.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(fs.readFileSync(store.storePath)).toEqual(indexBytes);
      expect(fs.readFileSync(transcriptPath)).toEqual(transcriptBytes);
      await runDoctorSessionSqlite({ env: store.env, store: store.storePath, mode: "import" });
      closeOpenClawAgentDatabasesForTest();
      const completed = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(completed.totals.removedFiles).toBe(2);
    },
  );

  it.each([
    { kind: "transcript", reverse: false },
    { kind: "transcript", reverse: true },
    { kind: "index", reverse: false },
    { kind: "index", reverse: true },
  ])(
    "retains remaining recovery when an admitted $kind disappears (reverse=$reverse)",
    async ({ kind, reverse }) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse,
      });
      const mainIndexPath = path.join(path.dirname(transcriptPath), "main.json");
      const siblingPath = path.join(path.dirname(transcriptPath), "main-private.jsonl");
      const mainIndex = JSON.parse(fs.readFileSync(mainIndexPath, "utf8"));
      mainIndex["agent:main:private"] = {
        sessionId: "main-private",
        sessionFile: "main-private.jsonl",
        updatedAt: 30,
      };
      fs.writeFileSync(mainIndexPath, JSON.stringify(mainIndex));
      fs.writeFileSync(siblingPath, '{"type":"session","id":"main-private","version":3}\n');
      const lastOwner = reverse ? "main" : "work";
      const lostPath =
        kind === "transcript"
          ? transcriptPath
          : path.join(path.dirname(transcriptPath), `${lastOwner}.json`);
      const originals = [...indexes, siblingPath, transcriptPath]
        .filter((file) => file !== lostPath)
        .map((file) => ({ file, bytes: fs.readFileSync(file) }));
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      let disappeared = false;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            !disappeared &&
            target.agentId === lastOwner &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has(`agent:${lastOwner}:main`)
          ) {
            // Both owners committed the source; lose recovery input before archival.
            fs.unlinkSync(lostPath);
            disappeared = true;
          }
          return result;
        });
      let imported;
      try {
        imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      } finally {
        spy.mockRestore();
      }
      expect(disappeared).toBe(true);
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
      for (const original of originals) {
        const locations = [
          original.file,
          ...manifest.targets.flatMap((target) =>
            target.plannedMoves
              .filter((move) => move.sourcePath === original.file)
              .map((move) => move.archivePath),
          ),
        ];
        expect(
          locations.filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file)),
        ).toContainEqual(original.bytes);
      }
      expect(retired.totals.removedFiles).toBe(2);
      const affectedOwners = imported.targets.filter((target) =>
        kind === "transcript" ? indexes.includes(target.storePath) : target.agentId === lastOwner,
      );
      const code =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      for (const owner of affectedOwners) {
        expect(owner.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
      }
    },
  );

  it.each([false, true])(
    "restores every shared-owner publication before reimport and retirement (separate=%s)",
    async (separateIndexes) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes,
        reverse: false,
      });
      const originals = [transcriptPath, ...indexes].map((file) => ({
        file,
        bytes: fs.readFileSync(file),
      }));
      const imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(imported.targets.flatMap((target) => target.issues)).toEqual([]);
      const restored = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "restore" });
      expect(restored.targets.flatMap((target) => target.issues)).toEqual([]);
      for (const original of originals) {
        expect(fs.existsSync(original.file)).toBe(true);
        expect(fs.readFileSync(original.file)).toEqual(original.bytes);
      }
      const reimported = await runDoctorSessionSqlite({
        cfg,
        env,
        allAgents: true,
        mode: "import",
      });
      expect(reimported.targets.flatMap((target) => target.issues)).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(retired.totals.removedFiles).toBe(separateIndexes ? 5 : 4);
    },
  );

  it.each(["shared", "distinct", "unreadable", "invalid-entry"] as const)(
    "retains known unselected index recovery (%s)",
    async (coverage) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse: false,
        sharedTranscript: coverage !== "distinct",
      });
      const workIndex = indexes[1]!;
      const siblingSource = path.join(path.dirname(transcriptPath), "main-private.jsonl");
      const mainIndex = JSON.parse(fs.readFileSync(indexes[0]!, "utf8"));
      mainIndex["agent:main:private"] = {
        sessionId: "main-private",
        sessionFile: "main-private.jsonl",
        updatedAt: 30,
      };
      fs.writeFileSync(indexes[0]!, JSON.stringify(mainIndex));
      fs.writeFileSync(siblingSource, '{"type":"session","id":"main-private","version":3}\n');
      const workSource =
        coverage === "distinct"
          ? path.join(path.dirname(transcriptPath), "work-session.jsonl")
          : transcriptPath;
      if (coverage === "unreadable") {
        fs.writeFileSync(workIndex, "{broken");
      }
      if (coverage === "invalid-entry") {
        fs.writeFileSync(
          workIndex,
          JSON.stringify({ "agent:work:main": { sessionFile: "main-session.jsonl" } }),
        );
      }
      const original = fs.readFileSync(workSource);
      const indexBytes = fs.readFileSync(workIndex);
      const report = await runDoctorSessionSqlite({ cfg, env, agent: "main", mode: "import" });
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(fs.existsSync(workSource)).toBe(true);
      expect(fs.readFileSync(workSource)).toEqual(original);
      expect(fs.readFileSync(workIndex)).toEqual(indexBytes);
      expect(cleanup.totals.removedFiles).toBe(coverage === "distinct" ? 3 : 0);
      if (coverage !== "distinct") {
        expect(report.targets[0]?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "transcript_archive_deferred" }),
          ]),
        );
      }
      expect(report.targets[0]?.archivedUnreferencedJsonlFiles).toEqual([]);
      // Keep the whole retained index usable; a direct retry must not orphan an earlier archive.
      if (coverage !== "distinct") {
        expect(fs.existsSync(siblingSource)).toBe(true);
      }
      if (coverage === "shared") {
        const retry = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
        expect(retry.targets.flatMap((target) => target.issues)).toEqual([]);
        closeOpenClawAgentDatabasesForTest();
        const retired = await retireSessionSqliteRecovery({
          env,
          preview: inspectSessionSqliteRecovery({ cfg, env }),
          readConfig: async () => cfg,
          confirm: async () => true,
        });
        const current = readMigrationManifest(retry.migrationRun?.manifestPath);
        for (const move of current.targets
          .flatMap((target) => target.completedMoves)
          .filter(
            (plannedMove) =>
              plannedMove.kind === "transcript" || plannedMove.kind === "legacy-store",
          )) {
          expect(retired.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
            "removed",
          );
        }
      }
    },
  );

  it.each([
    { separateIndexes: false, reverse: false },
    { separateIndexes: false, reverse: true },
    { separateIndexes: true, reverse: false },
    { separateIndexes: true, reverse: true },
  ])(
    "retains shared recovery through cleanup when one owner fails (separate=$separateIndexes, reverse=$reverse)",
    async ({ separateIndexes, reverse }) => {
      const fixture = createSharedRecoveryFixture({ separateIndexes, reverse });
      const { cfg, env, transcriptPath, indexes, independent } = fixture;
      const original = fs.readFileSync(transcriptPath);
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      let injected = false;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            target.agentId === "work" &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has("agent:work:main")
          ) {
            injected = true;
            return { ok: false, error: new Error("injected validation read failure") };
          }
          return result;
        });
      let report;
      try {
        report = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(
        report.targets
          .filter((target) => indexes.includes(target.storePath))
          .map((target) => target.agentId),
      ).toEqual(reverse ? ["work", "main"] : ["main", "work"]);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      expect(
        manifest.targets.find((target) => target.agentId === "work")?.validationBeforeArchive,
      ).toBe("failed");
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const originalLocations = [
        transcriptPath,
        ...manifest.targets.flatMap((target) =>
          target.plannedMoves
            .filter((move) => move.sourcePath === transcriptPath)
            .map((move) => move.archivePath),
        ),
      ];
      expect(
        originalLocations
          .filter((file) => fs.existsSync(file))
          .map((file) => fs.readFileSync(file)),
      ).toContainEqual(original);
      const independentMoves = manifest.targets.find(
        (target) => target.storePath === independent.storePath,
      )!.completedMoves;
      expect(
        independentMoves
          .filter((move) => move.kind === "transcript" || move.kind === "legacy-store")
          .every((move) =>
            cleanup.artifacts.some(
              (item) => item.path === move.archivePath && item.outcome === "removed",
            ),
          ),
      ).toBe(true);
      // Recovery and retry must remain usable with the failed owner's original index and bytes.
      await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "restore" });
      expect(fs.readFileSync(transcriptPath)).toEqual(original);
      expect(indexes.every((index) => fs.existsSync(index))).toBe(true);
      const retried = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(retried.targets.flatMap((target) => target.issues)).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const latest = readMigrationManifest(retried.migrationRun?.manifestPath);
      for (const move of latest.targets.flatMap((target) => target.completedMoves)) {
        expect(retired.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
          "removed",
        );
      }
    },
  );

  it.each([false, true])(
    "plans separate indexes before sweeping sibling transcripts (reverse=%s)",
    async (reverse) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse,
        sharedTranscript: false,
      });
      const report = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(report.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(
        report.targets
          .filter((target) => indexes.includes(target.storePath))
          .map((target) => target.agentId),
      ).toEqual(reverse ? ["work", "main"] : ["main", "work"]);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      for (const target of manifest.targets.filter((candidate) =>
        indexes.includes(candidate.storePath),
      )) {
        const expectedSource = path.join(
          path.dirname(transcriptPath),
          `${target.agentId}-session.jsonl`,
        );
        expect(target.completedMoves).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "transcript", sourcePath: expectedSource }),
          ]),
        );
      }
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(retired.totals.removedFiles).toBe(6);
    },
  );

  it.each(["transcript", "legacy-store"] as const)(
    "retains unique %s bytes changed at archival identity capture",
    async (kind) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
      const source = kind === "transcript" ? store.transcriptPath : store.storePath;
      const replacement =
        kind === "transcript"
          ? fs.readFileSync(source, "utf8") +
            JSON.stringify({
              type: "custom",
              id: "unique",
              customType: "late",
              data: "never imported",
            }) +
            "\n"
          : JSON.stringify({ "agent:main:unique": { sessionId: "unique", updatedAt: 9000 } });
      const readIdentity = migrationArtifact.readMigrationArtifactIdentity;
      let captures = 0;
      let injected = false;
      const spy = vi
        .spyOn(migrationArtifact, "readMigrationArtifactIdentity")
        .mockImplementation((file, ...args) => {
          if (file === source && ++captures === (kind === "transcript" ? 1 : 2)) {
            // Transcript: replace just before identity capture. Index: replace after the verified
            // identity is returned, before the publication owner plans the archive.
            if (kind === "legacy-store") {
              const identity = readIdentity(file, ...args);
              fs.writeFileSync(file, replacement);
              injected = true;
              return identity;
            }
            fs.unlinkSync(file);
            fs.writeFileSync(file, replacement);
            injected = true;
          }
          return readIdentity(file, ...args);
        });
      let imported;
      try {
        imported = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(fs.existsSync(source)).toBe(true);
      expect(fs.readFileSync(source, "utf8")).toBe(replacement);
      expect(
        imported.targets[0]?.issues.some(
          (issue) =>
            issue.code ===
            (kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed"),
        ),
      ).toBe(true);
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.artifacts.filter((item) => item.outcome === "removed")).toEqual([]);
      expect(fs.readFileSync(source, "utf8")).toBe(replacement);
      expect(
        JSON.stringify(
          loadTranscriptEventsSync({
            agentId: "main",
            storePath: store.storePath,
            sessionId: "session-1",
          }),
        ),
      ).not.toContain("never imported");
    },
  );

  it.each([1, 2] as const)(
    "retains historical v%s index and sibling history after partial adoption",
    async (version) => {
      const store = createLegacyStore({
        transcriptLines: [
          JSON.stringify({ type: "session", id: "session-1", version: 3 }),
          JSON.stringify({
            type: "message",
            id: "one",
            parentId: null,
            message: { role: "user", content: "original" },
          }),
        ],
      });
      const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
      const siblingSource = path.join(store.sessionDir, "second.jsonl");
      index["agent:main:second"] = {
        sessionId: "second",
        updatedAt: 2000,
        sessionFile: "second.jsonl",
      };
      fs.writeFileSync(store.storePath, JSON.stringify(index));
      fs.writeFileSync(
        siblingSource,
        JSON.stringify({ type: "session", id: "second", version: 3 }) + "\n",
      );
      const imported = await importLegacyStore(store);
      expect(imported.targets[0]?.issues).toEqual([]);
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = manifest.targets[0]!;
      const indexMove = target.plannedMoves.find((move) => move.kind === "legacy-store")!;
      const archivePath = target.plannedMoves.find(
        (move) => move.sourcePath === store.transcriptPath,
      )!.archivePath;
      const siblingArchive = target.plannedMoves.find(
        (move) => move.sourcePath === siblingSource,
      )!.archivePath;
      manifest.manifestVersion = version;
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        delete move.artifact;
      }
      fs.appendFileSync(
        archivePath,
        JSON.stringify({ type: "future_event", id: "unknown", payload: "unique original" }) + "\n",
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      closeOpenClawAgentDatabasesForTest();
      const originals = [indexMove.archivePath, archivePath, siblingArchive].map((file) => ({
        file,
        bytes: fs.readFileSync(file),
      }));
      const result = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      for (const original of originals) {
        expect(result.artifacts.find((item) => item.path === original.file)?.outcome).toBe(
          "protected",
        );
        expect(fs.readFileSync(original.file)).toEqual(original.bytes);
      }
      expect(result.totals.removedFiles).toBe(0);
    },
  );

  it("retires a successful reimport generation after restore consumed its predecessor", async () => {
    const { store } = await createVerifiedRecoveryStore();
    await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
    const reimported = await importLegacyStore(store);
    expect(reimported.targets[0]?.issues).toEqual([]);
    closeOpenClawAgentDatabasesForTest();
    const result = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(result.status).toBe("complete");
    expect(result.totals.removedFiles).toBe(2);
    const current = readMigrationManifest(reimported.migrationRun?.manifestPath);
    for (const move of current.targets[0]!.plannedMoves.filter(
      (item) => item.kind === "transcript" || item.kind === "legacy-store",
    )) {
      expect(move.artifact?.disposal.state).toBe("disposed");
    }
  });
});
