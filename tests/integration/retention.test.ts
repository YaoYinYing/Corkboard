import assert from "node:assert/strict";
import { test } from "node:test";
import { hashSecret, randomBase64url } from "../../src/auth/credentials.ts";
import { AppError } from "../../src/domain/errors.ts";
import { authenticateBearer } from "../../src/service/auth.ts";
import { revokeOAuthToken, rotateRefreshToken } from "../../src/service/oauth.ts";
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

function retentionDeps(fx: ServiceFixture, now: Date = NOW): RetentionDeps {
  fx.setNow(now);
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
  assert.deepEqual(
    (
      await fx.db.all<{ credential_id: string }>(
        "SELECT credential_id FROM oauth_token_clients ORDER BY credential_id",
      )
    ).map((row) => row.credential_id),
    ["cred_oat_with_refresh"],
    "the association of a credential blocked by a live refresh row is retained",
  );
});

test("a credential blocked by a live refresh row keeps its association, stays refreshable and revocable, then is pruned", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await fx.db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
     VALUES (?, ?, ?, ?)`,
    [
      base.projectId,
      base.speakerId,
      JSON.stringify(["message.read", "message.send"]),
      at(NOW, -DAY_MS),
    ],
  );
  await addCredential(fx, {
    id: "cred_oat_exp",
    speakerId: base.speakerId,
    revokedAt: null,
    expiresAt: at(NOW, -2 * DAY_MS),
  });
  await fx.db.run(
    "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
    ["cred_oat_exp", base.projectId, at(NOW, -2 * DAY_MS)],
  );
  await addTokenClient(fx, "cred_oat_exp", base.clientId);

  const refreshToken = `cb_ort_${randomBase64url(32)}`;
  await fx.db.run(
    `INSERT INTO oauth_refresh_tokens
       (id, family_id, client_id, credential_id, token_prefix, token_verifier,
        created_at, expires_at, revoked_at, rotated_at)
     VALUES ('rt_live_blocker', 'fam_blocker', ?, 'cred_oat_exp', ?, ?, ?, ?, NULL, NULL)`,
    [
      base.clientId,
      refreshToken.slice(0, 12),
      await hashSecret(refreshToken, fx.deps.pepper),
      at(NOW, -2 * DAY_MS),
      at(NOW, 30 * DAY_MS),
    ],
  );

  // The expired credential is blocked from deletion by the live refresh row and
  // must keep its ownership association.
  const first = await pruneRetention(retentionDeps(fx));
  assert.equal(first.oauthCredentials, 0);
  assert.equal(first.tokenClients, 0);
  assert.equal(await count(fx, "oauth_token_clients"), 1);
  assert.equal(await count(fx, "credentials"), 1);
  assert.equal(await count(fx, "credential_project_grants"), 1);

  // Refresh still works and yields a usable access token.
  const rotated = await rotateRefreshToken(fx.deps, {
    clientId: base.clientId,
    refreshToken,
  });
  const principal = await authenticateBearer(fx.deps, `Bearer ${rotated.access_token}`);
  assert.equal(principal.speakerId, base.speakerId);

  // RFC 7009 revocation with that access token is effective because the
  // association survived.
  await revokeOAuthToken(fx.deps, {
    clientId: base.clientId,
    token: rotated.access_token,
  });
  await assert.rejects(
    authenticateBearer(fx.deps, `Bearer ${rotated.access_token}`),
    (error: unknown) => error instanceof AppError && error.code === "UNAUTHENTICATED",
  );

  // Once refresh rows age out past grace, the credential, association, and
  // grant are deleted together.
  const later = new Date(NOW.getTime() + 25 * HOUR_MS);
  const laterSummary = await pruneRetention(retentionDeps(fx, later));
  assert.equal(laterSummary.refreshTokens, 2);
  assert.equal(laterSummary.tokenClients, 1);
  assert.equal(laterSummary.oauthCredentials, 1);
  assert.equal(await count(fx, "oauth_refresh_tokens"), 0);
  assert.equal(await count(fx, "oauth_token_clients"), 0);
  assert.equal(await count(fx, "credentials"), 0);
  assert.equal(await count(fx, "credential_project_grants"), 0);
});

test("grace-hours 0 deletes exactly at the cutoff and retains 1 ms younger", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);

  await addSession(fx, {
    id: "sess_revoked_exact",
    accountId: base.accountId,
    revokedAt: at(NOW, 0),
    expiresAt: at(NOW, 12 * HOUR_MS),
    lastSeenAt: at(NOW, 0),
  });
  await addSession(fx, {
    id: "sess_revoked_younger",
    accountId: base.accountId,
    revokedAt: at(NOW, 1),
    expiresAt: at(NOW, 12 * HOUR_MS),
    lastSeenAt: at(NOW, 0),
  });
  await addSession(fx, {
    id: "sess_expired_exact",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(NOW, 0),
    lastSeenAt: at(NOW, 0),
  });
  await addSession(fx, {
    id: "sess_expired_younger",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(NOW, 1),
    lastSeenAt: at(NOW, 0),
  });
  await addSession(fx, {
    id: "sess_idle_exact",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(NOW, 12 * HOUR_MS),
    lastSeenAt: at(NOW, -SESSION_IDLE_MS),
  });
  await addSession(fx, {
    id: "sess_idle_younger",
    accountId: base.accountId,
    revokedAt: null,
    expiresAt: at(NOW, 12 * HOUR_MS),
    lastSeenAt: at(NOW, -SESSION_IDLE_MS + 1),
  });

  await addCode(fx, base, {
    id: "code_consumed_exact",
    expiresAt: at(NOW, HOUR_MS),
    consumedAt: at(NOW, 0),
  });
  await addCode(fx, base, {
    id: "code_consumed_younger",
    expiresAt: at(NOW, HOUR_MS),
    consumedAt: at(NOW, 1),
  });
  await addCode(fx, base, {
    id: "code_expired_exact",
    expiresAt: at(NOW, 0),
    consumedAt: null,
  });
  await addCode(fx, base, {
    id: "code_expired_younger",
    expiresAt: at(NOW, 1),
    consumedAt: null,
  });

  await addCredential(fx, {
    id: "cred_oat_live",
    speakerId: base.speakerId,
    revokedAt: null,
    expiresAt: at(NOW, HOUR_MS),
  });
  await addTokenClient(fx, "cred_oat_live", base.clientId);
  for (const [id, expiresAt, revokedAt, rotatedAt] of [
    ["rt_expired_exact", at(NOW, 0), null, null],
    ["rt_expired_younger", at(NOW, 1), null, null],
    ["rt_revoked_exact", at(NOW, 30 * DAY_MS), at(NOW, 0), null],
    ["rt_revoked_younger", at(NOW, 30 * DAY_MS), at(NOW, 1), null],
    ["rt_rotated_exact", at(NOW, 30 * DAY_MS), null, at(NOW, 0)],
    ["rt_rotated_younger", at(NOW, 30 * DAY_MS), null, at(NOW, 1)],
  ] as const) {
    await addRefresh(fx, base, {
      id,
      credentialId: "cred_oat_live",
      expiresAt,
      revokedAt,
      rotatedAt,
    });
  }

  for (const [id, revokedAt, expiresAt] of [
    ["cred_revoked_exact", at(NOW, 0), at(NOW, HOUR_MS)],
    ["cred_revoked_younger", at(NOW, 1), at(NOW, HOUR_MS)],
    ["cred_expired_exact", null, at(NOW, 0)],
    ["cred_expired_younger", null, at(NOW, 1)],
  ] as const) {
    await addCredential(fx, { id, speakerId: base.speakerId, revokedAt, expiresAt });
    await addTokenClient(fx, id, base.clientId);
    await fx.db.run(
      "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
      [id, base.projectId, at(NOW, -DAY_MS)],
    );
  }

  const summary = await pruneRetention(retentionDeps(fx), { graceHours: 0 });

  assert.equal(summary.sessions, 3);
  assert.equal(summary.authorizationCodes, 2);
  assert.equal(summary.refreshTokens, 3);
  assert.equal(summary.tokenClients, 2);
  assert.equal(summary.oauthCredentials, 2);

  assert.equal(await count(fx, "sessions"), 4);
  assert.equal(await count(fx, "oauth_authorization_codes"), 2);
  assert.equal(await count(fx, "oauth_refresh_tokens"), 3);
  assert.equal(await count(fx, "credentials"), 3);
  assert.equal(await count(fx, "oauth_token_clients"), 3);
  assert.equal(await count(fx, "credential_project_grants"), 2);
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

test("limit is enforced for refresh, association, and credential tables too", async (t) => {
  const fx = await withFixture(t);
  const base = await seedBase(fx);
  await addCredential(fx, {
    id: "cred_oat_live",
    speakerId: base.speakerId,
    revokedAt: null,
    expiresAt: at(NOW, HOUR_MS),
  });
  await addTokenClient(fx, "cred_oat_live", base.clientId);
  for (const suffix of ["1", "2", "3"]) {
    await addRefresh(fx, base, {
      id: `rt_expired_${suffix}`,
      credentialId: "cred_oat_live",
      expiresAt: at(CUTOFF, -1),
      revokedAt: null,
      rotatedAt: null,
    });
    const credentialId = `cred_rev_${suffix}`;
    await addCredential(fx, {
      id: credentialId,
      speakerId: base.speakerId,
      revokedAt: at(CUTOFF, -1),
      expiresAt: at(NOW, HOUR_MS),
    });
    await addTokenClient(fx, credentialId, base.clientId);
    await fx.db.run(
      "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
      [credentialId, base.projectId, at(NOW, -DAY_MS)],
    );
  }
  // Three dangling associations exercise the orphan cleanup budget.
  await fx.db.exec("PRAGMA foreign_keys = OFF");
  for (const suffix of ["1", "2", "3"]) {
    await addTokenClient(fx, `cred_orphan_${suffix}`, base.clientId);
  }
  await fx.db.exec("PRAGMA foreign_keys = ON");

  const deps = retentionDeps(fx);
  const expected = [
    { refreshTokens: 2, tokenClients: 2, oauthCredentials: 2 },
    { refreshTokens: 1, tokenClients: 2, oauthCredentials: 1 },
    { refreshTokens: 0, tokenClients: 2, oauthCredentials: 0 },
    { refreshTokens: 0, tokenClients: 0, oauthCredentials: 0 },
  ];
  for (const counts of expected) {
    const summary = await pruneRetention(deps, { limit: 2 });
    assert.deepEqual(
      {
        refreshTokens: summary.refreshTokens,
        tokenClients: summary.tokenClients,
        oauthCredentials: summary.oauthCredentials,
      },
      counts,
    );
    for (const value of Object.values(counts)) {
      assert.ok(value <= 2, "each table stays within the requested limit");
    }
  }

  assert.equal(await count(fx, "oauth_refresh_tokens"), 0);
  assert.equal(await count(fx, "oauth_token_clients"), 1);
  assert.equal(await count(fx, "credentials"), 1);
  assert.equal(await count(fx, "credential_project_grants"), 0);
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
    { graceHours: 2_400_000_000 },
    { limit: 0 },
    { limit: 10_001 },
    { limit: 1.5 },
  ]) {
    await assert.rejects(pruneRetention(deps, options), RangeError);
  }
  assert.equal(await count(fx, "sessions"), 2);
});
