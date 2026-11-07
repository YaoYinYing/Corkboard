import type { SqlDatabase, SqlTransaction, SqlValue } from "./db.ts";

// Structural subset of the Cloudflare D1 API used by this port. The real
// `D1Database` is assignable to this shape; no `node:` or Cloudflare import is
// needed, so this module stays Web-standard.
export type D1Value = string | number | null;

export interface D1Result<T = Record<string, unknown>> {
  success?: boolean;
  results?: T[];
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<unknown>;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
}

// The documented D1 port: D1 has no interactive transactions, so `transaction`
// accepts only a write-only callback. Calls are buffered and submitted as one
// `batch()` after the callback resolves, and a throw discards the buffer
// (rollback). A buffered `run` resolves the documented `{ changes: 0 }` sentinel
// because the affected-row count does not exist before the batch runs; callers
// must never branch on an in-transaction `changes` value. Read-then-write
// callbacks (credential issuance/rotation/revocation, membership add/remove,
// grant add/remove) remain pre-existing debt and fail closed with
// READ_ONLY_TRANSACTION until a documented read-snapshot strategy exists. A
// non-undefined callback return value is rejected because a correct caller
// cannot observe a batch result and inventing one would hide that.
export const READ_ONLY_TRANSACTION =
  "D1 has no interactive transactions; write-only callbacks only";

function statement(
  d1: D1DatabaseLike,
  sql: string,
  params: readonly SqlValue[] | undefined,
): D1PreparedStatement {
  const prepared = d1.prepare(sql);
  return params === undefined ? prepared : prepared.bind(...params);
}

function affectedRows(result: D1Result): number {
  const changes = result.meta?.changes;
  return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}

export function createD1Database(d1: D1DatabaseLike): SqlDatabase {
  // Serialize access like the SQLite adapter: a top-level statement issued
  // while a transaction is buffered cannot interleave with its batch.
  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    exec(sql: string): Promise<void> {
      return enqueue(async () => {
        await d1.exec(sql);
      });
    },
    all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
      return enqueue(async () => {
        const result = await statement(d1, sql, params).all<T>();
        return result.results ?? [];
      });
    },
    first<T>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<T | undefined> {
      return enqueue(async () => {
        const row = await statement(d1, sql, params).first<T>();
        return row === null ? undefined : row;
      });
    },
    run(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<{ changes: number }> {
      return enqueue(async () => {
        const result = await statement(d1, sql, params).run();
        return { changes: affectedRows(result) };
      });
    },
    transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      return enqueue(async () => {
        const buffered: D1PreparedStatement[] = [];
        const tx: SqlTransaction = {
          // Reads cannot be served before the batch is submitted.
          all<T>(): Promise<T[]> {
            return Promise.reject(new Error(READ_ONLY_TRANSACTION));
          },
          first<T>(): Promise<T | undefined> {
            return Promise.reject(new Error(READ_ONLY_TRANSACTION));
          },
          run(
            sql: string,
            params?: readonly SqlValue[],
          ): Promise<{ changes: number }> {
            buffered.push(statement(d1, sql, params));
            // The affected-row count only exists after the batch runs. Callers
            // must not observe it (the port forbids result-dependent batches).
            return Promise.resolve({ changes: 0 });
          },
        };
        const result = await fn(tx);
        if (result !== undefined) {
          throw new Error(
            "D1 transactions are write-only; the callback must not return a value",
          );
        }
        await d1.batch(buffered);
        return result;
      });
    },
  };
}
