import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMemoryEmbedding } from "../../packages/memory-host-sdk/src/host/embedding-vector.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { decodeUsageCostRollup } from "../infra/session-cost-usage-rollup-codec.js";
import { createSessionUsageRollupData } from "../infra/session-cost-usage-rollup.js";
import { resolveZstdCodec } from "../infra/zstd-codec.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { seedOpenClawAgentSchemaV21 } from "./openclaw-agent-schema-v21.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";

afterEach(() => vi.restoreAllMocks());

function seedHistoricalData(db: DatabaseSync) {
  const event = ` {"type":"message","id":"first","id":"second","parentId":null,"message":{"role":"assistant","content":${JSON.stringify("saffronquasar 雪🦞 ".repeat(1024))}}}\n`;
  db.exec(`
    INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at)
      VALUES('agent:main:history', 'hot', '{"sessionId":"hot","updatedAt":2}', 2);
    INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
      VALUES('hot', 'agent:main:history', 1, 2), ('cold', 'agent:main:history', 1, 2);
    INSERT INTO transcript_rewrite_watermarks(session_id, generation, updated_at)
      VALUES('hot', 'original-generation', 2);
    UPDATE session_nodes SET entry_valid = 1 WHERE session_key = 'agent:main:history';
  `);
  const insert = db.prepare(
    "INSERT INTO transcript_events(rowid, session_id, seq, event_json, created_at) VALUES(?, 'hot', ?, ?, ?)",
  );
  insert.run(41, 7, event, 11);
  insert.run(52, 90, '{ "type": "custom", "data": "small 雪" }', 12);
  insert.run(63, 99, "{broken\0snow雪", 13);
  db.exec(`
    INSERT INTO transcript_event_identities(session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES('hot', 'first', 7, 'message', NULL, 'original-idempotency', 11);
    INSERT INTO session_transcript_active_events(session_id, active_position, event_seq, message_position, context_eligible)
      VALUES('hot', 0, 7, 0, 1);
    INSERT INTO session_transcript_fts(rowid, text, session_id, message_id, role, timestamp)
      VALUES
        (-17, 'saffronquasar', 'hot', 'first', 'assistant', '2026-09-18'),
        (42, 'saffronquasar', 'cold', 'cold-message', 'user', '2026-09-17'),
        (83, 'saffronquasar', 'hot', 'first', 'assistant', '2026-09-19'),
        (9007199254740993, 'saffronquasar', 'hot', NULL, 'tool', '2026-09-20');
    INSERT INTO memory_index_sources(path, source, hash, mtime, size)
      VALUES('memory/note.md', 'memory', 'source-hash', 1.5, 42);
    INSERT INTO memory_index_chunks(rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES(17, 'chunk', 'memory/note.md', 'memory', 1, 3, 'chunk-hash', 'synthetic', 'saffronquasar memory', '[1.0000000000000002,0.1]', 19);
    INSERT INTO memory_index_chunk_provenance(chunk_id, origin_class, session_kind, observed_at, supersedes_key)
      VALUES('chunk', 'owner', 'interactive', 18, 'older-chunk');
    INSERT INTO memory_index_chunk_recall_metadata(chunk_id, importance, triggers, project_key)
      VALUES('chunk', 7, '["saffronquasar"]', 'project');
    INSERT INTO memory_embedding_cache(rowid, provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES(23, 'synthetic', 'model', 'provider-key', 'chunk-hash', '[1.0000000000000002,0.1]', 2, 20);
  `);
  const archive = Buffer.from('{"type":"message","id":"cold-message"}\n');
  const codec = resolveZstdCodec();
  if (!codec) {
    throw new Error("Cold transcript fixture requires Zstd support");
  }
  const compressedArchive = codec.compress(archive);
  db.prepare(`INSERT INTO session_transcript_cold_archives
    (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage, archive_blob)
    VALUES('cold', 'cold-generation', 'cold.jsonl.zst', ?, 1, ?, ?, 10, 21, 'sqlite', ?)`).run(
    sha256Hex(compressedArchive),
    archive.length,
    compressedArchive.length,
    compressedArchive,
  );
  const rollup = createSessionUsageRollupData();
  rollup.untimestamped.totals.totalTokens = 17;
  const usage = {
    version: 6,
    pricingFingerprint: "synthetic",
    checkpoint: {
      kind: "jsonl",
      parsedOffset: 7,
      observedSize: 7,
      observedMtimeMs: 1,
      device: 1,
      inode: 2,
      anchorHash: "anchor",
    },
    scannedAt: 10,
    parsedRecords: 1,
    countedRecords: 0,
    rollup,
  };
  db.prepare(
    "INSERT INTO cache_entries(scope, key, value_json, blob, expires_at, updated_at) VALUES('session-cost-usage-rollup-v2', 'usage', ?, NULL, NULL, 31)",
  ).run(JSON.stringify(usage));
  return { event, usage };
}

const preservedTables = [
  "session_nodes",
  "session_windows",
  "transcript_event_identities",
  "session_transcript_active_events",
  "transcript_rewrite_watermarks",
  "session_transcript_cold_archives",
  "session_transcript_fts",
  "memory_index_sources",
  "memory_index_chunk_provenance",
  "memory_index_chunk_recall_metadata",
  "memory_index_state",
] as const;

function preservedRows(db: DatabaseSync) {
  return Object.fromEntries(
    preservedTables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}

function legacySnapshot(db: DatabaseSync) {
  const fts = db.prepare("SELECT rowid, * FROM session_transcript_fts ORDER BY rowid");
  fts.setReadBigInts(true);
  const matches = db.prepare(
    "SELECT rowid FROM session_transcript_fts WHERE session_transcript_fts MATCH 'saffronquasar' ORDER BY rank",
  );
  matches.setReadBigInts(true);
  return {
    schema: db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all(),
    version: db.prepare("PRAGMA user_version").get(),
    owner: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    events: db
      .prepare(
        "SELECT rowid, session_id, seq, hex(CAST(event_json AS BLOB)) AS bytes, created_at FROM transcript_events ORDER BY rowid",
      )
      .all(),
    chunks: db.prepare("SELECT rowid, * FROM memory_index_chunks ORDER BY rowid").all(),
    vectors: db.prepare("SELECT rowid, * FROM memory_embedding_cache ORDER BY rowid").all(),
    cache: db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all(),
    fts: fts.all(),
    matches: matches.all(),
    preserved: preservedRows(db),
  };
}

describe("agent schema 21 storage cutover", () => {
  it("rolls back converted storage when the maintenance scope rejects publication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("revoked-coverage21.sqlite");
      const db = new DatabaseSync(pathname);
      const scope = createOpenClawDatabaseMaintenanceScope();
      const refusal = new Error("Recovery backup coverage is no longer current");
      let reachedPublication = false;
      try {
        seedOpenClawAgentSchemaV21(db);
        seedHistoricalData(db);
        const before = legacySnapshot(db);
        scope.addAgentSchemaMigrationCheck((migration) => {
          if (
            migration.path === pathname &&
            db.prepare("PRAGMA user_version").get()?.user_version === OPENCLAW_AGENT_SCHEMA_VERSION
          ) {
            reachedPublication = true;
            throw refusal;
          }
        });
        await expect(
          scope.run(() =>
            withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
              ensureOpenClawAgentDatabaseSchema(db, {
                agentId: "main",
                path: pathname,
                env: state.env,
              });
            }),
          ),
        ).rejects.toBe(refusal);
        expect(reachedPublication).toBe(true);
        expect(legacySnapshot(db)).toEqual(before);
      } finally {
        try {
          await scope.close();
        } finally {
          db.close();
        }
      }
    });
  });

  it.each(["UTF-8", "UTF-16le"] as const)(
    "atomically publishes all new formats from a genuine %s schema21 database",
    async (encoding) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("legacy21.sqlite");
        let db = new DatabaseSync(pathname);
        let observer: DatabaseSync | undefined;
        try {
          db.exec(`PRAGMA encoding = '${encoding}'; PRAGMA journal_mode = WAL`);
          seedOpenClawAgentSchemaV21(db);
          const { event, usage } = seedHistoricalData(db);
          db.close();
          db = new DatabaseSync(pathname);
          const before = legacySnapshot(db);
          expect(
            db
              .prepare(
                `SELECT type, "notnull" AS not_null FROM pragma_table_info('transcript_events') WHERE name = 'event_json'`,
              )
              .get(),
          ).toEqual({ type: "TEXT", not_null: 1 });
          expect(
            db
              .prepare(
                "SELECT name FROM pragma_table_info('transcript_events') WHERE name = 'event_zstd'",
              )
              .get(),
          ).toBeUndefined();
          observer = new DatabaseSync(pathname, { readOnly: true });
          const reader = observer;
          let observedPublication = false;
          const exec = db.exec.bind(db);
          const write = vi.spyOn(db, "exec").mockImplementation((sql) => {
            exec(sql);
            if (/^PRAGMA user_version = 22;?$/.test(sql)) {
              observedPublication = true;
              expect(legacySnapshot(reader)).toEqual(before);
            }
          });
          await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
            ensureOpenClawAgentDatabaseSchema(db, {
              agentId: "main",
              path: pathname,
              env: state.env,
            });
          });
          write.mockRestore();
          expect(observedPublication).toBe(true);
          expect(reader.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
          });
          expect(reader.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
            schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
          });
          expect(preservedRows(reader)).toEqual(before.preserved);
          const fts = reader.prepare("SELECT rowid, * FROM session_transcript_fts ORDER BY rowid");
          fts.setReadBigInts(true);
          expect(fts.all()).toEqual(before.fts);
          const matches = reader.prepare(
            "SELECT rowid FROM session_transcript_fts WHERE session_transcript_fts MATCH 'saffronquasar' ORDER BY rank",
          );
          matches.setReadBigInts(true);
          expect(matches.all()).toEqual(before.matches);
          const identities = reader.prepare(
            "SELECT id, session_id, message_id FROM session_transcript_fts_rows ORDER BY id",
          );
          identities.setReadBigInts(true);
          expect(identities.all()).toEqual([
            { id: -17n, session_id: "hot", message_id: "first" },
            { id: 42n, session_id: "cold", message_id: "cold-message" },
            { id: 83n, session_id: "hot", message_id: "first" },
            { id: 9007199254740993n, session_id: "hot", message_id: null },
          ]);
          const rows = reader
            .prepare(
              "SELECT rowid, seq, event_json, event_zstd, event_utf8_bytes, hex(CAST(event_json AS BLOB)) AS bytes FROM transcript_events ORDER BY rowid",
            )
            .all();
          expect(rows.map((row) => [row.rowid, row.seq])).toEqual([
            [41, 7],
            [52, 90],
            [63, 99],
          ]);
          for (const [index, row] of rows.entries()) {
            if (row.event_zstd instanceof Uint8Array) {
              const codec = resolveZstdCodec();
              expect(codec).not.toBeNull();
              expect(
                codec!.decompress(row.event_zstd, Number(row.event_utf8_bytes)).toString("utf8"),
              ).toBe(event);
              expect(row.event_json).toBeNull();
            } else {
              expect(row.bytes).toBe(before.events[index]?.bytes);
            }
          }
          expect(rows[0]?.event_zstd instanceof Uint8Array).toBe(
            encoding === "UTF-8" && resolveZstdCodec() !== null,
          );
          const chunk = reader
            .prepare("SELECT chunk_rowid, embedding FROM memory_index_chunks WHERE id = 'chunk'")
            .get()!;
          expect(chunk.chunk_rowid).toBe(17);
          if (!(chunk.embedding instanceof Uint8Array)) {
            throw new Error("Expected binary chunk vector");
          }
          expect(decodeMemoryEmbedding(chunk.embedding)).toEqual([1 + Number.EPSILON, 0.1]);
          const vector = reader
            .prepare("SELECT rowid, embedding, dims, updated_at FROM memory_embedding_cache")
            .get()!;
          expect(vector).toMatchObject({ rowid: 23, dims: 2, updated_at: 20 });
          if (!(vector.embedding instanceof Uint8Array)) {
            throw new Error("Expected binary cached vector");
          }
          expect(decodeMemoryEmbedding(vector.embedding)).toEqual([1 + Number.EPSILON, 0.1]);
          const cached = reader
            .prepare(
              "SELECT scope, value_json, blob, updated_at FROM cache_entries WHERE key = 'usage'",
            )
            .get()!;
          expect(cached).toMatchObject({ scope: "session-cost-usage-rollup-v3", updated_at: 31 });
          if (typeof cached.value_json !== "string" || !(cached.blob instanceof Uint8Array)) {
            throw new Error("Expected migrated usage envelope/body");
          }
          expect(decodeUsageCostRollup(cached.value_json, "synthetic", cached.blob)).toEqual(usage);
          expect(reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
          expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        } finally {
          observer?.close();
          db.close();
        }
      });
    },
  );

  it.each(["publication interrupted", "maintenance authority lost"] as const)(
    "rolls every conversion back when %s",
    async (failure) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("interrupted21.sqlite");
        let db = new DatabaseSync(pathname);
        try {
          seedOpenClawAgentSchemaV21(db);
          seedHistoricalData(db);
          db.close();
          db = new DatabaseSync(pathname);
          const before = legacySnapshot(db);
          let reachedPublication = false;
          const migrating = withAgentDatabaseMaintenanceLease(
            { env: state.env },
            async (maintenance) => {
              if (failure === "publication interrupted") {
                db.setAuthorizer((action, name, value) => {
                  if (
                    action === constants.SQLITE_PRAGMA &&
                    name === "user_version" &&
                    value === "22"
                  ) {
                    reachedPublication = true;
                    return constants.SQLITE_DENY;
                  }
                  return constants.SQLITE_OK;
                });
              } else {
                const exec = db.exec.bind(db);
                vi.spyOn(db, "exec").mockImplementation((sql) => {
                  exec(sql);
                  if (/^PRAGMA user_version = 22;?$/.test(sql)) {
                    reachedPublication = true;
                    runOpenClawStateWriteTransaction(
                      ({ db: shared }) => {
                        shared
                          .prepare(
                            "UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ?",
                          )
                          .run(
                            AGENT_DATABASE_MAINTENANCE_LEASE.scope,
                            AGENT_DATABASE_MAINTENANCE_LEASE.key,
                          );
                      },
                      { env: state.env },
                    );
                  }
                });
              }
              try {
                ensureOpenClawAgentDatabaseSchema(db, {
                  agentId: "main",
                  path: pathname,
                  env: state.env,
                });
              } finally {
                db.setAuthorizer(null);
                vi.restoreAllMocks();
                if (failure === "maintenance authority lost" && reachedPublication) {
                  expect(() => maintenance.assertOwned()).toThrowError(
                    expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
                  );
                }
              }
            },
          );
          const rejection: unknown = await migrating.catch((error: unknown) => error);
          if (failure === "publication interrupted") {
            expect(rejection).toMatchObject({ message: expect.stringMatching(/authoriz/i) });
          } else {
            const pending = [rejection];
            const causes = new Set<unknown>();
            for (const error of pending) {
              if (causes.has(error)) {
                continue;
              }
              causes.add(error);
              if (error instanceof Error && error.cause) {
                pending.push(error.cause);
              }
              if (error instanceof AggregateError) {
                pending.push(...error.errors);
              }
            }
            expect(
              [...causes].some(
                (error) =>
                  error instanceof OpenClawStateLeaseError &&
                  error.code === "OPENCLAW_STATE_LEASE_LOST",
              ),
            ).toBe(true);
          }
          expect(reachedPublication).toBe(true);
          expect(legacySnapshot(db)).toEqual(before);
          expect(
            db
              .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_transcript_fts_rows'")
              .get(),
          ).toBeUndefined();
          expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
          await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
            ensureOpenClawAgentDatabaseSchema(db, {
              agentId: "main",
              path: pathname,
              env: state.env,
            });
          });
          expect(db.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
          });
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
          db.close();
        }
      });
    },
  );
});
