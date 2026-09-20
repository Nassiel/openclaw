import type { DatabaseSync } from "node:sqlite";
import { sql, type Expression, type RawBuilder } from "kysely";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  projectModelContextEventSql,
  projectModelContextNavigationSql,
  projectResetBoundaryNavigationSql,
  projectTranscriptPayloadNavigationSql,
} from "./session-model-context-projection.js";

export const MAX_COMPRESSED_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_NAVIGATION_BYTES = 16 * 1024;
const MIN_COMPRESS_BYTES = 1024;
const DECODE_FUNCTION = "openclaw_transcript_payload_decode";
const registeredDecoders = new WeakSet<DatabaseSync>();
const utf8Databases = new WeakMap<DatabaseSync, boolean>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type TranscriptPayloadRecord = {
  event_json: string | null;
  event_zstd: Uint8Array | null;
  event_utf8_bytes: number | null;
  navigation_json: string | null;
};

export type TranscriptPayloadAlias = "transcript_events" | "event" | "te" | "parent";

/** Physical payload writes participate in the transcript owner's admitted transaction. */
export function createTranscriptEventInserter(database: DatabaseSync, sessionId: string) {
  const insert = prepareSqliteQuerySync<
    TranscriptPayloadRecord & { seq: number; createdAt: number }
  >(database, (parameter) =>
    getNodeSqliteKysely<Pick<DB, "transcript_events">>(database)
      .insertInto("transcript_events")
      .values({
        session_id: sessionId,
        seq: parameter((row) => row.seq),
        event_json: parameter((row) => row.event_json),
        event_zstd: parameter((row) => row.event_zstd),
        event_utf8_bytes: parameter((row) => row.event_utf8_bytes),
        navigation_json: parameter((row) => row.navigation_json),
        created_at: parameter((row) => row.createdAt),
      }),
  );
  return (row: { seq: number; eventJson: string; createdAt: number }) =>
    insert({ ...row, ...prepareTranscriptPayload(database, row.eventJson) });
}

export function createTranscriptPayloadUpdater(database: DatabaseSync, sessionId: string) {
  return prepareSqliteQuerySync<TranscriptPayloadRecord & { seq: number }>(database, (parameter) =>
    getNodeSqliteKysely<Pick<DB, "transcript_events">>(database)
      .updateTable("transcript_events")
      .set({
        event_json: parameter((row) => row.event_json),
        event_zstd: parameter((row) => row.event_zstd),
        event_utf8_bytes: parameter((row) => row.event_utf8_bytes),
        navigation_json: parameter((row) => row.navigation_json),
      })
      .where("session_id", "=", sessionId)
      .where(
        "seq",
        "=",
        parameter((row) => row.seq),
      ),
  );
}

function hasUtf8Storage(database: DatabaseSync): boolean {
  let utf8 = utf8Databases.get(database);
  if (utf8 === undefined) {
    const db = getNodeSqliteKysely<{ pragma_encoding: { encoding: string } }>(database);
    utf8 =
      executeSqliteQueryTakeFirstSync(database, db.selectFrom("pragma_encoding").select("encoding"))
        ?.encoding === "UTF-8";
    utf8Databases.set(database, utf8);
  }
  return utf8;
}

function navigationProjection(event: Expression<string>): RawBuilder<string | null> {
  return /* kysely-allow-raw: record native projections and exact byte costs; exceptional envelopes retain identity behavior. */ sql<
    string | null
  >`CASE WHEN json_valid(${event}) THEN CASE
    WHEN json_type(${event}) != 'object'
      OR coalesce(json_type(${event}, '$.message'), 'null') NOT IN ('object', 'null') THEN NULL
    ELSE json_object('version', 1,
      'navigation', json(${projectTranscriptPayloadNavigationSql(event)}),
      'reset', json(${projectResetBoundaryNavigationSql(event)}),
      'model', json(${projectModelContextNavigationSql(event)}),
      'modelBytes', octet_length(${projectModelContextEventSql(event, sql.lit(0))}),
      'modelWithoutCheckpointBytes', octet_length(${projectModelContextEventSql(event, sql.lit(1))}),
      'withoutCustomDataBytes', octet_length(json_remove(${event}, '$.data')))
    END ELSE NULL END`;
}

type NavigationReader = (eventJson: string) => { navigation_json: string | null } | undefined;
const navigationReaders = new WeakMap<DatabaseSync, NavigationReader>();

function readNavigation(database: DatabaseSync, eventJson: string): string | null {
  let read = navigationReaders.get(database);
  if (!read) {
    read = prepareSqliteQueryTakeFirstSync<string, { navigation_json: string | null }>(
      database,
      (parameter) => {
        const db = getNodeSqliteKysely<Record<string, never>>(database);
        const metadata = db
          .selectFrom(db.selectNoFrom(parameter((value) => value).as("event_json")).as("source"))
          .select((eb) => navigationProjection(eb.ref("source.event_json")).as("navigation_json"));
        const admitted = /* kysely-allow-raw: reject oversized metadata natively before returning its text to JavaScript. */ sql<
          string | null
        >`CASE WHEN octet_length(metadata.navigation_json) <= ${MAX_NAVIGATION_BYTES}
          THEN metadata.navigation_json ELSE NULL END`;
        return (
          db
            // The size guard and returned value must reuse one envelope, not flatten into two projections.
            .with(
              (cte) => cte("metadata").materialized(),
              () => metadata,
            )
            .selectFrom("metadata")
            .select(admitted.as("navigation_json"))
        );
      },
    );
    navigationReaders.set(database, read);
  }
  const navigation = read(eventJson)?.navigation_json ?? null;
  return navigation !== null && Buffer.byteLength(navigation, "utf8") <= MAX_NAVIGATION_BYTES
    ? navigation
    : null;
}

/** Prepare canonical UTF-8 bytes and native query metadata before publishing a transcript row. */
export function prepareTranscriptPayload(
  database: DatabaseSync,
  eventJson: string,
): TranscriptPayloadRecord {
  const rawBytes = Buffer.byteLength(eventJson, "utf8");
  const utf8 = hasUtf8Storage(database);
  const identity: TranscriptPayloadRecord = {
    event_json: eventJson,
    event_zstd: null,
    event_utf8_bytes: utf8 ? rawBytes : null,
    navigation_json: null,
  };
  // Giant identity values stay available to native SQL without a second full buffer or projection.
  // SQLite and JS can disagree on escaped surrogates and embedded NUL; retain the native path.
  if (
    !utf8 ||
    rawBytes > MAX_COMPRESSED_EVENT_BYTES ||
    eventJson.includes("\\u") ||
    eventJson.includes("\0")
  ) {
    return identity;
  }
  const codec = resolveZstdCodec();
  if (!codec || rawBytes < MIN_COMPRESS_BYTES) {
    return identity;
  }
  const bytes = Buffer.from(eventJson, "utf8");
  // A literal unpaired surrogate cannot round-trip through a UTF-8 frame.
  if (utf8Decoder.decode(bytes) !== eventJson) {
    return identity;
  }
  const compressed = codec.compress(bytes, 1, true);
  const maximumStoredBytes = rawBytes - Math.max(64, Math.ceil(rawBytes / 10));
  if (compressed.byteLength > maximumStoredBytes) {
    return identity;
  }
  const navigation = readNavigation(database, eventJson);
  if (
    navigation === null ||
    compressed.byteLength + Buffer.byteLength(navigation, "utf8") > maximumStoredBytes
  ) {
    return identity;
  }
  return { ...identity, event_json: null, event_zstd: compressed, navigation_json: navigation };
}

function registerDecoder(database: DatabaseSync): void {
  if (registeredDecoders.has(database)) {
    return;
  }
  database.function(
    DECODE_FUNCTION,
    { deterministic: true, directOnly: true },
    (bytes, rawBytes) => {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_COMPRESSED_EVENT_BYTES ||
        typeof rawBytes !== "number" ||
        !Number.isSafeInteger(rawBytes) ||
        rawBytes < 1 ||
        rawBytes > MAX_COMPRESSED_EVENT_BYTES
      ) {
        throw new Error("Invalid compressed transcript payload bounds");
      }
      const codec = resolveZstdCodec();
      if (!codec) {
        throw new Error(
          "Cannot decode compressed transcript payload: this runtime lacks zstd support",
        );
      }
      const decoded = codec.decompress(bytes, rawBytes);
      if (decoded.byteLength !== rawBytes) {
        throw new Error(
          "Compressed transcript payload length does not match its recorded UTF-8 size",
        );
      }
      return utf8Decoder.decode(decoded);
    },
  );
  registeredDecoders.add(database);
}

/** Only selected bodies decode; identity TEXT remains inside SQLite for native repairs. */
export function transcriptEventJsonSql(
  database: DatabaseSync,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<string> {
  registerDecoder(database);
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the canonical identity column. */ sql.ref(
      `${alias}.event_json`,
    );
  const compressed =
    /* kysely-allow-raw: closed transcript aliases select the canonical compressed column. */ sql.ref(
      `${alias}.event_zstd`,
    );
  const bytes =
    /* kysely-allow-raw: closed transcript aliases select recorded canonical byte counts. */ sql.ref(
      `${alias}.event_utf8_bytes`,
    );
  const decode = getNodeSqliteKysely<Record<string, never>>(database).fn<string>(DECODE_FUNCTION, [
    compressed,
    bytes,
  ]);
  return /* kysely-allow-raw: lazy payload selection keeps giant identity TEXT out of the bounded JS decoder. */ sql<string>`CASE WHEN ${identity} IS NOT NULL THEN ${identity}
    ELSE ${decode} END`;
}

export function transcriptEventNavigationSql(
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<string> {
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  return storedProjectionSql("navigation", identity, alias);
}

function storedProjectionSql(
  field: "navigation" | "reset" | "model",
  fallback: Expression<string>,
  alias: TranscriptPayloadAlias,
): RawBuilder<string> {
  const metadata =
    /* kysely-allow-raw: closed transcript aliases select the native navigation envelope. */ sql.ref(
      `${alias}.navigation_json`,
    );
  return /* kysely-allow-raw: exceptional identity rows retain native projection; other rows use the recorded owner projection. */ sql<string>`CASE WHEN ${metadata} IS NULL THEN ${fallback}
    ELSE json_extract(${metadata}, ${`$.${field}`}) END`;
}

export function transcriptEventResetNavigationSql(
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<string> {
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  return storedProjectionSql("reset", projectResetBoundaryNavigationSql(identity), alias);
}

export function transcriptEventModelNavigationSql(
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<string> {
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  return storedProjectionSql("model", projectModelContextNavigationSql(identity), alias);
}

/** Model admission retains projected byte costs, which can be much smaller than canonical JSON. */
export function transcriptEventModelBytesSql(
  omitCheckpoint: Expression<number>,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<number> {
  const metadata =
    /* kysely-allow-raw: closed transcript aliases select native projection accounting. */ sql.ref(
      `${alias}.navigation_json`,
    );
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  return /* kysely-allow-raw: native fallback preserves UTF-16 byte units; metadata excludes the JSONL separator. */ sql<number>`CASE WHEN ${metadata} IS NULL
    THEN octet_length(${projectModelContextEventSql(identity, omitCheckpoint)})
    ELSE json_extract(${metadata}, CASE WHEN ${omitCheckpoint} = 1
      THEN '$.modelWithoutCheckpointBytes' ELSE '$.modelBytes' END) END`;
}

/** Suffix admission can retain opaque custom data without charging or decoding its body. */
export function transcriptEventWithoutCustomDataBytesSql(
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<number> {
  const metadata =
    /* kysely-allow-raw: closed transcript aliases select native projection accounting. */ sql.ref(
      `${alias}.navigation_json`,
    );
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref(
      `${alias}.event_json`,
    );
  return /* kysely-allow-raw: preserve the native json_remove cost used by retained-custom suffix projection. */ sql<number>`CASE WHEN ${metadata} IS NULL
    THEN octet_length(json_remove(${identity}, '$.data'))
    ELSE json_extract(${metadata}, '$.withoutCustomDataBytes') END`;
}

export function transcriptEventUtf8BytesSql(
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<number | null> {
  return /* kysely-allow-raw: closed transcript aliases select known UTF-8 bytes without loading payloads. */ sql.ref<
    number | null
  >(`${alias}.event_utf8_bytes`);
}
