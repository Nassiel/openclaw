// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { assertSafeSessionSqliteMigrationMove } from "./doctor-session-sqlite-migration-run.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreSessionSqliteMigrationRun } from "./doctor-session-sqlite-restore.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  setupDoctorSessionSqliteTest,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  trustedMigrationTarget,
  canonicalTestPath,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = setupDoctorSessionSqliteTest();

// Vitest canonicalizes TMPDIR; alias coverage needs the platform's /tmp path.
const lexicalRootTempDir = path.resolve("/tmp");
const realRootTempDir = canonicalTestPath(lexicalRootTempDir);
const hasPlatformRootTempAlias = lexicalRootTempDir !== realRootTempDir;

describe("runDoctorSessionSqlite", () => {
  it("rejects malformed restore manifests without throwing", async () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "malformed-manifest.json");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        manifestVersion: 1,
        runId: "malformed",
        targets: {},
      })}\n`,
      { mode: 0o600 },
    );

    const restore = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore).toMatchObject({
      conflicts: [
        {
          archivePath: manifestPath,
          reason: "manifest is missing or unreadable",
          sourcePath: manifestPath,
        },
      ],
      restoredFiles: [],
      skippedFiles: [],
    });
  });

  it("rejects restore moves outside the manifest target archive boundary", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "restore-boundary manifest target test invariant",
    );
    const outsideSourcePath = path.join(store.tempDir, "outside-source.jsonl");
    const outsideArchivePath = path.join(store.tempDir, "outside-archive.jsonl");
    fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
    const unsafeMove = {
      archivePath: outsideArchivePath,
      kind: "transcript" as const,
      sourcePath: outsideSourcePath,
    };
    target.plannedMoves = [unsafeMove];
    target.completedMoves = [unsafeMove];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restore = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore.conflicts).toEqual([
      {
        archivePath: manifestPath,
        reason: "manifest is missing or unreadable",
        sourcePath: manifestPath,
      },
    ]);
    expect(fs.existsSync(outsideSourcePath)).toBe(false);
    expect(fs.existsSync(outsideArchivePath)).toBe(true);
  });

  it("rejects migration sources outside the target sessions directory", () => {
    const store = createLegacyStore();
    const outsideSourcePath = path.join(store.tempDir, "outside-source.jsonl");
    const archivePath = path.join(
      path.dirname(store.sessionDir),
      "session-sqlite-import-archive",
      "outside-source.jsonl.imported-1",
    );
    fs.writeFileSync(outsideSourcePath, '{"type":"outside"}\n', { mode: 0o600 });

    expect(() =>
      assertSafeSessionSqliteMigrationMove(
        {
          archivePath,
          kind: "transcript",
          sourcePath: outsideSourcePath,
        },
        trustedMigrationTarget(store),
      ),
    ).toThrow("Migration source is outside the target sessions directory");
    expect(fs.existsSync(outsideSourcePath)).toBe(true);
  });

  it("rejects a coherently rewritten target that is not trusted by the caller", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "untrusted-target manifest target test invariant",
    );
    const outsideSessionsDir = path.join(store.tempDir, "outside-agent", "sessions");
    const outsideStorePath = path.join(outsideSessionsDir, "sessions.json");
    const outsideSourcePath = path.join(outsideSessionsDir, "outside.jsonl");
    const outsideArchiveDir = path.join(
      path.dirname(outsideSessionsDir),
      "session-sqlite-import-archive",
    );
    const outsideArchivePath = path.join(outsideArchiveDir, "outside.jsonl.imported-1");
    fs.mkdirSync(outsideArchiveDir, { recursive: true });
    fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
    const rewrittenMove = {
      archivePath: outsideArchivePath,
      kind: "transcript" as const,
      sourcePath: outsideSourcePath,
    };
    target.storePath = outsideStorePath;
    target.plannedMoves = [rewrittenMove];
    target.completedMoves = [rewrittenMove];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restore = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore.conflicts).toEqual([
      {
        archivePath: manifestPath,
        reason: "manifest does not match a trusted session target",
        sourcePath: manifestPath,
      },
    ]);
    expect(fs.existsSync(outsideSourcePath)).toBe(false);
    expect(fs.existsSync(outsideArchivePath)).toBe(true);
  });

  it("rejects recovery manifests with a rewritten SQLite path", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "rewritten-sqlite manifest target test invariant",
    );
    const outsideSqlitePath = path.join(store.tempDir, "outside.sqlite");
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    target.issues = [{ code: "startup_failure", message: "failed after archive" }];
    target.sqlitePath = outsideSqlitePath;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const recover = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(recover.migrationRun).toBeUndefined();
    expect(recover.targets[0]?.issues[0]?.code).toBe("recover_manifest_missing");
    expect(fs.existsSync(outsideSqlitePath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "uses normalized restore paths instead of symlink-parent traversal paths",
    async () => {
      const store = createLegacyStore();
      const importReport = await importLegacyStore(store);
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "normalized-restore manifest target test invariant",
      );
      const plannedMove = expectDefined(
        target.plannedMoves[0],
        "normalized-restore planned move test invariant",
      );
      const archiveDir = path.dirname(plannedMove.archivePath);
      const outsideDir = path.join(store.tempDir, "outside", "nested");
      const outsideArchivePath = path.join(path.dirname(outsideDir), "payload.jsonl");
      const traversalArchivePath = path.join(archiveDir, "escape", "..", "payload.jsonl");
      const sourcePath = path.join(canonicalTestPath(store.sessionDir), "payload.jsonl");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(archiveDir, "escape"));
      fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
      const traversalMove = {
        archivePath: traversalArchivePath,
        kind: "transcript" as const,
        sourcePath,
      };
      target.plannedMoves = [traversalMove];
      target.completedMoves = [traversalMove];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      const restore = await restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: path.join(archiveDir, "payload.jsonl"),
          reason: "source and archive are both missing",
          sourcePath,
        },
      ]);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(outsideArchivePath)).toBe(true);
    },
  );

  it.skipIf(!hasPlatformRootTempAlias)(
    "restores version 1 manifests written through a platform root alias",
    async () => {
      const store = createLegacyStore({ tempRoot: lexicalRootTempDir });
      const importReport = await importLegacyStore(store);
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const aliasPath = (filePath: string) =>
        path.join(lexicalRootTempDir, path.relative(realRootTempDir, filePath));
      manifest.manifestVersion = 1;
      for (const manifestTarget of manifest.targets) {
        for (const candidate of [
          ...manifestTarget.plannedMoves,
          ...manifestTarget.completedMoves,
        ]) {
          delete candidate.artifact;
        }
      }
      for (const target of manifest.targets) {
        target.sqlitePath = aliasPath(target.sqlitePath);
        target.storePath = aliasPath(target.storePath);
        for (const move of [...target.plannedMoves, ...target.completedMoves]) {
          move.archivePath = aliasPath(move.archivePath);
          move.sourcePath = aliasPath(move.sourcePath);
        }
      }
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      const restore = await restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([]);
      expect(restore.restoredFiles).toContain(canonicalTestPath(store.transcriptPath));
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    },
  );

  it.skipIf(!hasPlatformRootTempAlias)(
    "imports, previews, and restores a legacy store through a platform root alias",
    async () => {
      const store = createLegacyStore({ tempRoot: lexicalRootTempDir });

      const report = await importLegacyStore(store);

      expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      expect(manifest.targets[0]?.storePath).toBe(
        path.join(realRootTempDir, path.relative(lexicalRootTempDir, store.storePath)),
      );
      expect(
        manifest.targets[0]?.completedMoves.every((move) =>
          move.sourcePath.startsWith(realRootTempDir + path.sep),
        ),
      ).toBe(true);
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.some((artifact) => artifact.runs.length > 0)).toBe(true);

      const restored = await runDoctorSessionSqlite({
        env: store.env,
        mode: "restore",
        store: store.storePath,
      });
      expect(restored.targets[0]?.restore?.conflicts).toEqual([]);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
      expect(fs.existsSync(store.storePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects version 1 manifests through non-root directory symlinks",
    async () => {
      const store = createLegacyStore();
      const importReport = await importLegacyStore(store);
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "version-1 symlink manifest target test invariant",
      );
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
        "version-1 symlink transcript move test invariant",
      );
      manifest.manifestVersion = 1;
      for (const manifestTarget of manifest.targets) {
        for (const candidate of [
          ...manifestTarget.plannedMoves,
          ...manifestTarget.completedMoves,
        ]) {
          delete candidate.artifact;
        }
      }
      manifest.startedAt = "2999-01-01T00:00:00.000Z";
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const agentDir = path.dirname(store.sessionDir);
      const relocatedAgentDir = path.join(store.tempDir, "relocated-v1-agent");
      fs.renameSync(agentDir, relocatedAgentDir);
      fs.symlinkSync(relocatedAgentDir, agentDir);

      const restore = await restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: manifestPath,
          reason: "manifest is missing or unreadable",
          sourcePath: manifestPath,
        },
      ]);
      expect(fs.existsSync(move.sourcePath)).toBe(false);
      expect(fs.existsSync(move.archivePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked ancestor shared by restore directories",
    async () => {
      const store = createLegacyStore();
      const importReport = await importLegacyStore(store);
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "shared-symlink manifest target test invariant",
      );
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
        "shared-symlink transcript move test invariant",
      );
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const agentDir = path.dirname(store.sessionDir);
      const relocatedAgentDir = path.join(store.tempDir, "relocated-agent");
      fs.renameSync(agentDir, relocatedAgentDir);
      fs.symlinkSync(relocatedAgentDir, agentDir);

      const restore = await restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: move.archivePath,
          reason: "source or archive parent is a symbolic link; refusing restore",
          sourcePath: move.sourcePath,
        },
      ]);
      expect(restore.restoredFiles).toEqual([]);
      expect(fs.existsSync(move.archivePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects restores through a symlinked source directory",
    async () => {
      const store = createLegacyStore();
      const importReport = await importLegacyStore(store);
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "source-symlink manifest target test invariant",
      );
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
        "source-symlink transcript move test invariant",
      );
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const relocatedSessionDir = path.join(store.tempDir, "relocated-sessions");
      fs.renameSync(store.sessionDir, relocatedSessionDir);
      fs.symlinkSync(relocatedSessionDir, store.sessionDir);

      const restore = await restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: move.archivePath,
          reason: "source or archive parent is a symbolic link; refusing restore",
          sourcePath: move.sourcePath,
        },
      ]);
      expect(restore.restoredFiles).toEqual([]);
      expect(fs.existsSync(move.archivePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects restores through a symlinked archive directory",
    async () => {
      const store = createLegacyStore();
      const importReport = await importLegacyStore(store);
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "archive-symlink manifest target test invariant",
      );
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
        "archive-symlink transcript move test invariant",
      );
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const archiveDir = path.dirname(move.archivePath);
      const relocatedArchiveDir = path.join(store.tempDir, "relocated-archive");
      fs.renameSync(archiveDir, relocatedArchiveDir);
      fs.symlinkSync(relocatedArchiveDir, archiveDir);

      const restore = await restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: move.archivePath,
          reason: "source or archive parent is a symbolic link; refusing restore",
          sourcePath: move.sourcePath,
        },
      ]);
      expect(restore.restoredFiles).toEqual([]);
      expect(fs.existsSync(move.archivePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")("rejects symlinked archive entries", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "archive-entry manifest target test invariant",
    );
    const move = expectDefined(
      target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
      "archive-entry transcript move test invariant",
    );
    target.plannedMoves = [move];
    target.completedMoves = [move];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const outsidePath = path.join(store.tempDir, "outside-payload.jsonl");
    fs.writeFileSync(outsidePath, '{"type":"outside"}\n', { mode: 0o600 });
    fs.rmSync(move.archivePath);
    fs.symlinkSync(outsidePath, move.archivePath);

    const restore = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore.conflicts).toEqual([
      {
        archivePath: move.archivePath,
        reason: "archive is not a regular file; refusing restore",
        sourcePath: move.sourcePath,
      },
    ]);
    expect(restore.restoredFiles).toEqual([]);
    expect(fs.existsSync(move.sourcePath)).toBe(false);
    expect(fs.existsSync(outsidePath)).toBe(true);
  });
});
