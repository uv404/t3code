/**
 * Adds the nullable `native_session_id` column to `provider_session_runtime`,
 * recording which harness-owned session a thread was imported from.
 *
 * The partial unique index is the point of this migration. "One native session
 * has at most one T3 thread" is the invariant that keeps import idempotent and
 * keeps two T3 threads from becoming competing writers on the same transcript;
 * enforcing it in SQL makes it hold under concurrent imports, which a
 * read-then-write check in application code cannot. It is partial (`WHERE
 * native_session_id IS NOT NULL`) because the overwhelming majority of rows are
 * ordinary T3-created sessions, and SQLite would otherwise treat every NULL as
 * distinct anyway — being explicit documents that NULLs are not participants.
 *
 * The column is nullable and unbackfilled: rows written before this migration
 * describe sessions T3 itself created, which by definition have no native id.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!columns.some((column) => column.name === "native_session_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN native_session_id TEXT
    `;
  }

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_session_runtime_native_session
    ON provider_session_runtime(provider_name, native_session_id)
    WHERE native_session_id IS NOT NULL
  `;
});
