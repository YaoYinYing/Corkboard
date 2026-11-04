import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pruneRetention,
  type RetentionDeps,
} from "../../src/service/retention.ts";
import { SESSION_IDLE_MS } from "../../src/service/sessions.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - DAY_MS);
const IDLE_CUTOFF = new Date(CUTOFF.getTime() - SESSION_IDLE_MS);

function at(base: Date, deltaMs: number): string {
  return new Date(base.getTime() + deltaMs).toISOString();
}

function retentionDeps(fx: ServiceFixture): RetentionDeps {
  fx.setNow(NOW);
  return { db: fx.db, now: fx.deps.now };
}

interface Base {
  accountId: string;
  speakerId: string;
  projectId: string;
  clientId: string;
  sessionId: string;
}

async function seedBase(fx: ServiceFixture): Promise<Base> {
  const ids: Base = {
    accountId: "acct_1",
    speakerId: "spk_1",
    projectId: "proj_1",
    clientId: "cb_cli_1",
    sessionId: "sess_live",
  };
  await fx.db.run(
    "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
    [ids.accountId, `${ids.accountId}@example.test`, at(NOW, 0)],
  );
  await fx.db.run(
    "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [ids.speakerId, ids.accountId, ids.speakerId, at(NOW, 0)],
  );
  await fx.db.run(
    "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [ids.projectId, ids.accountId, ids.projectId, at(NOW, 0)],
  );
  await fx.db.run(
    `INSERT INTO oauth_clients
       (id, client_id, client_name, redirect_uris_json, grant_types_json,
        response_types_json, created_at, status)
     VALUES (?, ?, 'test client', '["https://client.example/cb"]',
             '["authorization_code","refresh_token"]', '["code"]', ?, 'active')`,
    [`oac_1`, ids.clientId, at(NOW, 0)],
  );
  await addSession(fx, {
    id: ids.sessionId,
    accountId: ids.accountId,
    revokedAt: null,
    expiresAt: at(NOW, 12 * HOUR_MS),
    lastSeenAt: at(NOW, 0),
  });
  return ids;
}

async function addSession(
  fx: ServiceFixture,
  row: {
    id: string;
    accountId: string;
    revokedAt: string | null;
    expiresAt: string;
    lastSeenAt: string;
  },
): Promise<void> {
  await fx.db.run(
    `INSERT INTO sessions
       (id, account_id, token_prefix, token_verifier, csrf_verifier,
        created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?, ?, ?, 'v', 'c', ?, ?, ?, ?)`,
    [
      row.id,
      row.accountId,
      row.id.slice(0, 16).padEnd(16, "x"),
      at(NOW, -DAY_MS),
      row.lastSeenAt,
      row.expiresAt,
      row.revokedAt,
    ],
  );
}

async function addCredential(
  fx: ServiceFixture,
  row: {
    id: string;
    speakerId: string;
    revokedAt: string | null;
    expiresAt: string | null;
    publicPrefix?: string;
  },
): Promise<void> {
  await fx.db.run(
    `INSERT INTO credentials
       (id, speaker_id, public_prefix, secret_verifier, scope_json,
        expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, 'v', '["message.read"]', ?, ?, ?)`,
    [
      row.id,
      row.speakerId,
      row.publicPrefix ?? "cb_oat_aaaaa",
      row.expiresAt,
      row.revokedAt,
      at(NOW, -DAY_MS),
    ],
  );
}

async function addTokenClient(
  fx: ServiceFixture,
  credentialId: string,
  clientId: string,
): Promise<void> {
  await fx.db.run(
    "INSERT INTO oauth_token_clients (credential_id, client_id, created_at) VALUES (?, ?, ?)",
    [credentialId, clientId, at(NOW, -DAY_MS)],
  );
}

async function addCode(
  fx: ServiceFixture,
  base: Base,
  row: { id: string; sessionId?: string; expiresAt: string; consumedAt: string | null },
): Promise<void> {
  await fx.db.run(
    `INSERT INTO oauth_authorization_codes
       (id, client_id, account_id, speaker_id, project_id, session_id, scopes_json,
        code_prefix, code_verifier_hash, redirect_uri, resource, expires_at,
        consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '["message.read"]', ?, 'hash',
             'https://client.example/cb', 'https://corkboard.example', ?, ?, ?)`,
    [
      row.id,
      base.clientId,
      base.accountId,
      base.speakerId,
      base.projectId,
      row.sessionId ?? base.sessionId,
      row.id.padEnd(12, "x").slice(0, 12),
      row.expiresAt,
      row.consumedAt,
      at(NOW, -DAY_MS),
    ],
  );
}

async function addRefresh(
  fx: ServiceFixture,
  base: Base,
  row: {
    id: string;
    credentialId: string;
    expiresAt: string;
    revokedAt: string | null;
    rotatedAt: string | null;
  },
): Promise<void> {
  await fx.db.run(
    `INSERT INTO oauth_refresh_tokens
       (id, family_id, client_id, credential_id, token_prefix, token_verifier,
        created_at, expires_at, revoked_at, rotated_at)
     VALUES (?, 'fam_1', ?, ?, ?, 'v', ?, ?, ?, ?)`,
    [
      row.id,
      base.clientId,
      row.credentialId,
      row.id.padEnd(12, "x").slice(0, 12),
      at(NOW, -DAY_MS),
      row.expiresAt,
      row.revokedAt,
      row.rotatedAt,
    ],
  );
}

async function count(fx: ServiceFixture, table: string): Promise<number> {
  const row = await fx.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? -1;
}

async function withFixture(t: {
  after(fn: () => void): void;
}): Promise<ServiceFixture> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return fx;
}

test("sessions: only unusable rows past grace are deleted", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  const rows: Array<[string, string | null, string, string]> = [
    // id, revoked_at, expires_at, last_seen_at
    ["sess_active", null, at(NOW, 12 * HOUR_MS), at(NOW, 0)],
    // Unusable but within grace: retained.
    ["sess_revoked_inside", at(CUTOFF, 1), at(NOW, 12 * HOUR_MS), at(NOW, 0)],
    ["sess_expired_inside", null, at(CUTOFF, 1), at(NOW, 0)],
    // Unusable and past grace: deleted.
    ["sess_revoked_over", at(CUTOFF, -1), at(NOW, 12 * HOUR_MS), at(NOW, 0)],
    ["sess_expired_over", null, at(CUTOFF, -1), at(NOW, 0)],
  ];
  for (const [id, revokedAt, expiresAt, lastSeenAt] of rows) {
    await addSession(fx, {
      id,
      accountId: base.accountId,
      revokedAt,
      expiresAt,
      lastSeenAt,
    });
  }
  await addSession(fx, {
    id: "sess_idle_over",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(NOW, 12 * HOUR_MS),
    lastSeenAt: at(IDLE_CUTOFF, -1),
  });
  await addSession(fx, {
    id: "sess_idle_inside",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(NOW, 12 * HOUR_MS),
    lastSeenAt: at(IDLE_CUTOFF, 1),
  });

  const summary = await pruneRetention(retentionDeps(fx));

  assert.equal(summary.sessions, 3);
  const remaining = await fx.db.all<{ id: string }>("SELECT id FROM sessions ORDER BY id");
  assert.deepEqual(
    remaining.map((row) => row.id),
    [
      "sess_active",
      "sess_expired_inside",
      "sess_idle_inside",
      base.sessionId,
      "sess_revoked_inside",
    ],
  );
});

test("authorization codes: consumed and expired past grace only", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await addCode(fx, base, {
    id: "code_live",
    expiresAt: at(NOW, 5 * 60 * 1000),
    consumedAt: null,
  });
  await addCode(fx, base, {
    id: "code_consumed_inside",
    expiresAt: at(NOW, -HOUR_MS),
    consumedAt: at(CUTOFF, 1),
  });
  await addCode(fx, base, {
    id: "code_consumed_over",
    expiresAt: at(NOW, -HOUR_MS),
    consumedAt: at(CUTOFF, -1),
  });
  await addCode(fx, base, {
    id: "code_expired_inside",
    expiresAt: at(CUTOFF, 1),
    consumedAt: null,
  });
  await addCode(fx, base, {
    id: "code_expired_over",
    expiresAt: at(CUTOFF, -1),
    consumedAt: null,
  });

  const summary = await pruneRetention(retentionDeps(fx));

  assert.equal(summary.authorizationCodes, 2);
  const remaining = await fx.db.all<{ id: string }>(
    "SELECT id FROM oauth_authorization_codes ORDER BY id",
  );
  assert.deepEqual(
    remaining.map((row) => row.id),
    ["code_consumed_inside", "code_expired_inside", "code_live"],
  );
});

test("refresh tokens: expired, revoked, and rotated past grace only", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await addCredential(fx, {
    id: "cred_oat_live",
    speakerId: base.speakerId,
    revokedAt: null,
    expiresAt: at(NOW, HOUR_MS),
  });
  await addTokenClient(fx, "cred_oat_live", base.clientId);
  const rows = [
    ["rt_live", at(NOW, 30 * DAY_MS), null, null],
    ["rt_expired_inside", at(CUTOFF, 1), null, null],
    ["rt_expired_over", at(CUTOFF, -1), null, null],
    ["rt_revoked_over", at(NOW, 30 * DAY_MS), at(CUTOFF, -1), null],
    ["rt_rotated_over", at(NOW, 30 * DAY_MS), null, at(CUTOFF, -1)],
    ["rt_rotated_inside", at(NOW, 30 * DAY_MS), null, at(CUTOFF, 1)],
  ] as const;
  for (const [id, expiresAt, revokedAt, rotatedAt] of rows) {
    await addRefresh(fx, base, {
      id,
      credentialId: "cred_oat_live",
      expiresAt,
      revokedAt,
      rotatedAt,
    });
  }

  const summary = await pruneRetention(retentionDeps(fx));

  assert.equal(summary.refreshTokens, 3);
  assert.equal(summary.oauthCredentials, 0);
  const remaining = await fx.db.all<{ id: string }>(
    "SELECT id FROM oauth_refresh_tokens ORDER BY id",
  );
  assert.deepEqual(
    remaining.map((row) => row.id),
    ["rt_expired_inside", "rt_live", "rt_rotated_inside"],
  );
});

test("token clients: orphans and revoked/expired associations only", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await addCredential(fx, {
    id: "cred_oat_live",
    speakerId: base.speakerId,
    revokedAt: null,
    expiresAt: at(NOW, HOUR_MS),
  });
  await addTokenClient(fx, "cred_oat_live", base.clientId);
  // A dangling association can only exist after an out-of-band credential
  // removal; seed it with FK enforcement temporarily off.
  await fx.db.exec("PRAGMA foreign_keys = OFF");
  await addTokenClient(fx, "cred_gone", base.clientId);
  await fx.db.exec("PRAGMA foreign_keys = ON");
  await addCredential(fx, {
    id: "cred_oat_revoked",
    speakerId: base.speakerId,
    revokedAt: at(CUTOFF, -1),
    expiresAt: at(NOW, HOUR_MS),
  });
  await addTokenClient(fx, "cred_oat_revoked", base.clientId);
  await addCredential(fx, {
    id: "cred_oat_expired_inside",
    speakerId: base.speakerId,
    revokedAt: null,
    expiresAt: at(CUTOFF, 1),
  });
  await addTokenClient(fx, "cred_oat_expired_inside", base.clientId);

  const summary = await pruneRetention(retentionDeps(fx));

  assert.equal(summary.tokenClients, 2);
  assert.equal(summary.oauthCredentials, 1);
  const remaining = await fx.db.all<{ credential_id: string }>(
    "SELECT credential_id FROM oauth_token_clients ORDER BY credential_id",
  );
  assert.deepEqual(
    remaining.map((row) => row.credential_id),
    ["cred_oat_expired_inside", "cred_oat_live"],
  );
  const credentials = await fx.db.all<{ id: string }>(
    "SELECT id FROM credentials ORDER BY id",
  );
  assert.deepEqual(
    credentials.map((row) => row.id),
    ["cred_oat_expired_inside", "cred_oat_live"],
  );
});

test("oauth credentials need no refresh row; cb_ speaker credentials are never eligible", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await addCredential(fx, {
    id: "cred_oat_revoked",
    speakerId: base.speakerId,
    revokedAt: at(CUTOFF, -1),
    expiresAt: at(NOW, HOUR_MS),
  });
  await fx.db.run(
    "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
    ["cred_oat_revoked", base.projectId, at(NOW, -DAY_MS)],
  );
  await addTokenClient(fx, "cred_oat_revoked", base.clientId);

  // A revoked credential whose refresh row is still live is retained.
  await addCredential(fx, {
    id: "cred_oat_with_refresh",
    speakerId: base.speakerId,
    revokedAt: at(CUTOFF, -1),
    expiresAt: at(NOW, HOUR_MS),
  });
  await addTokenClient(fx, "cred_oat_with_refresh", base.clientId);
  await addRefresh(fx, base, {
    id: "rt_live",
    credentialId: "cred_oat_with_refresh",
    expiresAt: at(NOW, 30 * DAY_MS),
    revokedAt: null,
    rotatedAt: null,
  });

  // A speaker credential has no oauth_token_clients association.
  await addCredential(fx, {
    id: "cred_speaker",
    speakerId: base.speakerId,
    revokedAt: at(CUTOFF, -1),
    expiresAt: at(NOW, HOUR_MS),
    publicPrefix: "cb_speaker_",
  });

  const summary = await pruneRetention(retentionDeps(fx));

  assert.equal(summary.oauthCredentials, 1);
  assert.equal(summary.refreshTokens, 0);
  const credentials = await fx.db.all<{ id: string }>(
    "SELECT id FROM credentials ORDER BY id",
  );
  assert.deepEqual(
    credentials.map((row) => row.id),
    ["cred_oat_with_refresh", "cred_speaker"],
  );
  assert.equal(
    await count(fx, "credential_project_grants"),
    0,
    "grants of a deleted OAuth credential are removed",
  );
});

test("limit is a per-table batch and a second run is a no-op", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  for (const suffix of ["1", "2", "3"]) {
    await addSession(fx, {
      id: `sess_expired_${suffix}`,
      accountId: base.accountId,
      revokedAt: null,
      expiresAt: at(CUTOFF, -1),
      lastSeenAt: at(NOW, 0),
    });
    await addCode(fx, base, {
      id: `code_expired_${suffix}`,
      expiresAt: at(CUTOFF, -1),
      consumedAt: null,
    });
  }

  const deps = retentionDeps(fx);
  const first = await pruneRetention(deps, { limit: 2 });
  assert.equal(first.sessions, 2);
  assert.equal(first.authorizationCodes, 2);

  const second = await pruneRetention(deps, { limit: 2 });
  assert.equal(second.sessions, 1);
  assert.equal(second.authorizationCodes, 1);

  const third = await pruneRetention(deps, { limit: 2 });
  assert.deepEqual(third, {
    graceHours: 24,
    limit: 2,
    sessions: 0,
    authorizationCodes: 0,
    refreshTokens: 0,
    tokenClients: 0,
    oauthCredentials: 0,
  });

  // Only the deliberately live session remains.
  assert.equal(await count(fx, "sessions"), 1);
  assert.equal(await count(fx, "oauth_authorization_codes"), 0);
});

test("an injected delete failure rolls back every table", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await addSession(fx, {
    id: "sess_expired",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(CUTOFF, -1),
    lastSeenAt: at(NOW, 0),
  });
  await addCode(fx, base, {
    id: "code_expired",
    sessionId: "sess_expired",
    expiresAt: at(CUTOFF, -1),
    consumedAt: null,
  });

  await fx.db.exec(
    `CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions
     BEGIN SELECT RAISE(ABORT, 'injected retention failure'); END`,
  );
  await assert.rejects(
    pruneRetention(retentionDeps(fx)),
    /injected retention failure/,
  );
  assert.equal(await count(fx, "sessions"), 2);
  assert.equal(await count(fx, "oauth_authorization_codes"), 1);

  await fx.db.exec("DROP TRIGGER fail_session_delete");
  const summary = await pruneRetention(retentionDeps(fx));
  assert.equal(summary.sessions, 1);
  assert.equal(summary.authorizationCodes, 1);
});

test("messages, receipts, blobs, and audit events are untouched", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await fx.db.run(
    `INSERT INTO body_objects (id, project_id, storage_key, state, created_at)
     VALUES ('obj_1', ?, 'AAAAAAAAAAAAAAAAAAAA', 'ready', ?)`,
    [base.projectId, at(NOW, -DAY_MS)],
  );
  await fx.db.run(
    `INSERT INTO messages
       (id, project_id, sender_speaker_id, summary, type, language, received_at, body_state)
     VALUES ('msg_1', ?, ?, 'summary', 'request', 'en', ?, 'pending')`,
    [base.projectId, base.speakerId, at(NOW, -DAY_MS)],
  );
  await fx.db.run(
    "INSERT INTO message_receipts (message_id, speaker_id, read_at) VALUES ('msg_1', ?, ?)",
    [base.speakerId, at(NOW, -DAY_MS)],
  );
  await fx.db.run(
    `INSERT INTO audit_events (id, operation, outcome, created_at)
     VALUES ('evt_1', 'message.expire', 'success', ?)`,
    [at(NOW, -DAY_MS)],
  );
  await addSession(fx, {
    id: "sess_expired",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(CUTOFF, -1),
    lastSeenAt: at(NOW, 0),
  });

  const before = {
    messages: await count(fx, "messages"),
    receipts: await count(fx, "message_receipts"),
    objects: await count(fx, "body_objects"),
    audit: await count(fx, "audit_events"),
  };
  const summary = await pruneRetention(retentionDeps(fx));
  assert.equal(summary.sessions, 1);
  assert.deepEqual(
    {
      messages: await count(fx, "messages"),
      receipts: await count(fx, "message_receipts"),
      objects: await count(fx, "body_objects"),
      audit: await count(fx, "audit_events"),
    },
    before,
  );
});

test("invalid grace and limit are rejected before any delete", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await addSession(fx, {
    id: "sess_expired",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(CUTOFF, -1),
    lastSeenAt: at(NOW, 0),
  });
  const deps = retentionDeps(fx);

  for (const options of [
    { graceHours: -1 },
    { graceHours: Number.NaN },
    { graceHours: Number.POSITIVE_INFINITY },
    { limit: 0 },
    { limit: 10_001 },
    { limit: 1.5 },
  ]) {
    await assert.rejects(pruneRetention(deps, options), RangeError);
  }
  assert.equal(await count(fx, "sessions"), 2);
});
