import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSpeakerToken, hashSecret } from "../../src/auth/credentials.ts";
import { inMemoryKeyProvider } from "../../src/crypto/keys.ts";
import { SCOPES, type Scope } from "../../src/domain/authz.ts";
import { authenticateBearer, type Principal, type ServiceDeps } from "../../src/service/auth.ts";
import { MemoryBlobStore } from "../../src/storage/blobs/memory.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";

export const ALL_SCOPES: readonly Scope[] = SCOPES;

export interface CredentialOptions {
  id?: string;
  speakerId: string;
  /** Supply a token to construct synthetic prefix collisions. */
  token?: string;
  scopes?: readonly Scope[];
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

export interface ServiceFixture {
  deps: ServiceDeps;
  db: ServiceDeps["db"] & { close(): void };
  blobs: MemoryBlobStore;
  setNow(date: Date): void;
  addAccount(id: string, status?: string): Promise<void>;
  addSpeaker(id: string, accountId: string, status?: string): Promise<void>;
  addProject(id: string, ownerAccountId: string, status?: string): Promise<void>;
  addMembership(projectId: string, speakerId: string, capabilities?: readonly Scope[]): Promise<void>;
  addCredential(options: CredentialOptions): Promise<{ token: string; credentialId: string }>;
  expireMessage(messageId: string): Promise<void>;
  authenticate(token: string): Promise<Principal>;
  close(): void;
}

export async function createServiceFixture(): Promise<ServiceFixture> {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-service-"));
  const db = await openSqliteDatabase(join(dir, "service.sqlite"));
  const blobs = new MemoryBlobStore();
  const keys = await inMemoryKeyProvider(crypto.getRandomValues(new Uint8Array(32)));
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  let currentTime = new Date("2026-11-03T12:00:00.000Z");

  const deps: ServiceDeps = {
    db,
    blobs,
    keys,
    pepper,
    serviceId: "svc_test",
    now: () => new Date(currentTime.getTime()),
  };

  const stamp = (): string => currentTime.toISOString();

  return {
    deps,
    db,
    blobs,
    setNow(date: Date): void {
      currentTime = new Date(date.getTime());
    },
    async addAccount(id: string, status = "active"): Promise<void> {
      await db.run(
        "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, ?, ?)",
        [id, `${id}@example.test`, status, stamp()],
      );
    },
    async addSpeaker(id: string, accountId: string, status = "active"): Promise<void> {
      await db.run(
        "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, accountId, id, status, stamp()],
      );
    },
    async addProject(id: string, ownerAccountId: string, status = "active"): Promise<void> {
      await db.run(
        "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, ownerAccountId, id, status, stamp()],
      );
    },
    async addMembership(
      projectId: string,
      speakerId: string,
      capabilities: readonly Scope[] = ALL_SCOPES,
    ): Promise<void> {
      await db.run(
        `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
         VALUES (?, ?, ?, ?)`,
        [projectId, speakerId, JSON.stringify(capabilities), stamp()],
      );
    },
    async addCredential(options: CredentialOptions): Promise<{ token: string; credentialId: string }> {
      const credentialId = options.id ?? `cred_${crypto.randomUUID()}`;
      const token = options.token ?? generateSpeakerToken().token;
      const publicPrefix = token.slice(0, 12);
      const verifier = await hashSecret(token, pepper);
      await db.run(
        `INSERT INTO credentials
           (id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          credentialId,
          options.speakerId,
          publicPrefix,
          verifier,
          JSON.stringify(options.scopes ?? ALL_SCOPES),
          options.expiresAt === undefined || options.expiresAt === null
            ? null
            : options.expiresAt.toISOString(),
          options.revokedAt === undefined || options.revokedAt === null
            ? null
            : options.revokedAt.toISOString(),
          stamp(),
        ],
      );
      return { token, credentialId };
    },
    async expireMessage(messageId: string): Promise<void> {
      await db.run("UPDATE messages SET body_state = 'expired' WHERE id = ?", [messageId]);
    },
    authenticate(token: string): Promise<Principal> {
      return authenticateBearer(deps, `Bearer ${token}`);
    },
    close(): void {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
