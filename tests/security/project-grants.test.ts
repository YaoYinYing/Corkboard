import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { AppError } from "../../src/domain/errors.ts";
import { authorizeProject } from "../../src/service/auth.ts";
import { createServiceFixture } from "../helpers/service-fixture.ts";

function forbidden(error: unknown): boolean {
  return error instanceof AppError && error.code === "FORBIDDEN";
}

function notFound(error: unknown): boolean {
  return error instanceof AppError && error.code === "NOT_FOUND";
}

test("a valid credential with no grant is denied even for an active membership", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_alice");
  await fx.addSpeaker("spk_alice", "acct_alice");
  await fx.addProject("proj_a", "acct_alice");
  await fx.addMembership("proj_a", "spk_alice", undefined, {
    grantExistingCredentials: false,
  });

  const { token } = await fx.addCredential({
    speakerId: "spk_alice",
    autoGrantMemberships: false,
  });
  const principal = await fx.authenticate(token);
  await assert.rejects(
    authorizeProject(fx.deps, principal, "proj_a", "project.read"),
    forbidden,
  );
});

test("grants are per credential and never widen on a new membership", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_alice");
  await fx.addSpeaker("spk_alice", "acct_alice");
  for (const project of ["proj_a", "proj_b"]) {
    await fx.addProject(project, "acct_alice");
    await fx.addMembership(project, "spk_alice", undefined, {
      grantExistingCredentials: false,
    });
  }

  // Speaker is a member of A and B, but this key is granted only A.
  const keyA = await fx.addCredential({
    speakerId: "spk_alice",
    autoGrantMemberships: false,
    grantProjects: ["proj_a"],
  });
  const principalA = await fx.authenticate(keyA.token);
  await authorizeProject(fx.deps, principalA, "proj_a", "project.read");
  await assert.rejects(
    authorizeProject(fx.deps, principalA, "proj_b", "project.read"),
    forbidden,
  );

  // A second key granted only B has the mirror-image restriction.
  const keyB = await fx.addCredential({
    speakerId: "spk_alice",
    autoGrantMemberships: false,
    grantProjects: ["proj_b"],
  });
  const principalB = await fx.authenticate(keyB.token);
  await authorizeProject(fx.deps, principalB, "proj_b", "project.read");
  await assert.rejects(
    authorizeProject(fx.deps, principalB, "proj_a", "project.read"),
    forbidden,
  );

  // Joining C after issuance grants neither credential anything.
  await fx.addProject("proj_c", "acct_alice");
  await fx.addMembership("proj_c", "spk_alice", undefined, {
    grantExistingCredentials: false,
  });
  for (const principal of [principalA, principalB]) {
    await assert.rejects(
      authorizeProject(fx.deps, principal, "proj_c", "project.read"),
      forbidden,
    );
  }

  // A grant without an active membership remains invisible (NOT_FOUND).
  await fx.addProject("proj_d", "acct_alice");
  await fx.grantProject(keyA.credentialId, "proj_d");
  await assert.rejects(
    authorizeProject(fx.deps, principalA, "proj_d", "project.read"),
    notFound,
  );
});

test("project enumeration only returns granted projects", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_alice");
  await fx.addSpeaker("spk_alice", "acct_alice");
  for (const project of ["proj_a", "proj_b"]) {
    await fx.addProject(project, "acct_alice");
    await fx.addMembership(project, "spk_alice", undefined, {
      grantExistingCredentials: false,
    });
  }
  const keyA = await fx.addCredential({
    speakerId: "spk_alice",
    autoGrantMemberships: false,
    grantProjects: ["proj_a"],
  });

  const app = createApp(fx.deps);
  const call = (path: string): Promise<Response> =>
    app(
      new Request(`http://localhost${path}`, {
        headers: { authorization: `Bearer ${keyA.token}` },
      }),
    );

  const me = (await (await call("/api/v1/me")).json()) as { projects: string[] };
  assert.deepEqual(me.projects, ["proj_a"]);

  const list = (await (await call("/api/v1/projects")).json()) as {
    projects: Array<{ id: string }>;
  };
  assert.deepEqual(
    list.projects.map((project) => project.id),
    ["proj_a"],
  );

  // A detail request for an ungranted project is FORBIDDEN, not a leak.
  const denied = await call("/api/v1/projects/proj_b");
  assert.equal(denied.status, 403);
  assert.equal(
    ((await denied.json()) as { error: { code: string } }).error.code,
    "FORBIDDEN",
  );
});

test("grant revocation applies to an already authenticated principal", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_alice");
  await fx.addSpeaker("spk_alice", "acct_alice");
  await fx.addProject("proj_a", "acct_alice");
  await fx.addMembership("proj_a", "spk_alice", undefined, {
    grantExistingCredentials: false,
  });
  const key = await fx.addCredential({
    speakerId: "spk_alice",
    autoGrantMemberships: false,
    grantProjects: ["proj_a"],
  });
  const principal = await fx.authenticate(key.token);
  await authorizeProject(fx.deps, principal, "proj_a", "project.read");

  await fx.revokeProjectGrant(key.credentialId, "proj_a");
  await assert.rejects(
    authorizeProject(fx.deps, principal, "proj_a", "project.read"),
    forbidden,
  );
});
