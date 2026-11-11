import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  GUARD_STALE_MS,
  InboxError,
  SUPERVISOR_GUARD_DIR,
  SUPERVISOR_LOCK_FILE,
  ackEvent,
  acquireSupervisorLock,
  clearStaleSupervisorLock,
  enqueueEvent,
  forceClearSupervisorLock,
  inspectSupervisorLock,
  openSpool,
  pendingEvents,
  prepareSpool,
  readCursorAfterSeq,
  reclaimStaleSupervisorLock,
  registerConsumer,
} from "../../src/inbox/index.ts";
import { spawn, type ChildProcess } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "corkboard-inbox-supervisor-unit-"));
after(() => rmSync(root, { recursive: true, force: true }));

const PROJECT = "proj_1";
const BASE = "http://127.0.0.1:9";
const TOKEN = "supervisor-synthetic-token";
const NOW = () => new Date("2026-11-11T12:00:00.000Z");

function newDir(name: string): string {
  return join(root, `${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
}

function message(seq: number) {
  return {
    projectId: PROJECT,
    messageId: `msg_${seq}`,
    seq,
    senderId: "spk_sender",
    summary: `summary ${seq}`,
    bodyState: "ready" as const,
  };
}

function isInbox(code: string, exitCode: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof InboxError);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    return true;
  };
}

function bootId(): string | null {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function lockRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    instance: "0123456789abcdef0123456789abcdef",
    pid: process.pid,
    boot_id: bootId(),
    process_start: processStart(process.pid),
    project_id: PROJECT,
    base_url: BASE,
    started_at: NOW().toISOString(),
    ...overrides,
  };
}

function writeLock(dir: string, record: Record<string, unknown>): void {
  const path = join(dir, SUPERVISOR_LOCK_FILE);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before the deadline");
}

function stopChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(child.pid, signal);
    } catch {
      // Already gone.
    }
  }
}

test("exclusive lock: one live holder wins and a second start fails closed", () => {
  const dir = newDir("exclusive");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  const first = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  assert.equal(inspectSupervisorLock(spool).state, "live");

  assert.throws(
    () => acquireSupervisorLock(openSpool(dir), { baseUrl: BASE, now: NOW }),
    isInbox("INBOX_LOCKED", 1),
  );
  assert.equal(inspectSupervisorLock(spool).state, "live");

  first.release();
  assert.equal(inspectSupervisorLock(spool).state, "absent");
  const second = acquireSupervisorLock(openSpool(dir), { baseUrl: BASE, now: NOW });
  second.release();
});

test("a boot-id mismatch (reboot) makes the old lock stale and recoverable", () => {
  const dir = newDir("reboot");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  writeLock(dir, lockRecord({ boot_id: "boot-from-a-previous-boot" }));

  const inspection = inspectSupervisorLock(spool);
  assert.equal(inspection.state, "stale");
  assert.equal(inspection.reason, "boot");

  const lock = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  assert.notEqual(lock.record.instance, "0123456789abcdef0123456789abcdef");
  assert.equal(inspectSupervisorLock(spool).state, "live");
  lock.release();
});

test("a dead PID (crash) makes the old lock stale, while a live paused process holds it", async (t) => {
  const dir = newDir("crash");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  // A PID above the Linux pid_max and with a recorded process-start that no
  // longer exists is treated as a crashed process, not as bare-PID liveness.
  writeLock(dir, lockRecord({ pid: 2_147_483_647, process_start: "1" }));
  const inspection = inspectSupervisorLock(spool);
  assert.equal(inspection.state, "stale");
  assert.equal(inspection.reason, "process-gone");
  const recovered = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  recovered.release();

  // A SIGSTOPp'd child is alive and still holds the lock: liveness uses
  // (pid, boot id, process start), not "is the process making progress".
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => {
    stopChild(child, "SIGKILL");
  });
  await waitFor(() => child.pid !== undefined && processStart(child.pid) !== null);
  const pid = child.pid;
  assert.ok(pid !== undefined);
  stopChild(child, "SIGSTOP");
  await waitFor(() => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("T");
  });
  writeLock(
    dir,
    lockRecord({ pid, process_start: processStart(pid), boot_id: bootId() }),
  );
  assert.equal(inspectSupervisorLock(spool).state, "live");
  assert.equal(clearStaleSupervisorLock(spool), "live");
});

test("a PID-reuse mismatch and corrupt or symlinked locks fail closed", () => {
  const dir = newDir("reuse");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  writeLock(dir, lockRecord({ process_start: "1" }));
  assert.equal(inspectSupervisorLock(spool).reason, "pid-reused");
  const recovered = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  recovered.release();

  writeFileSync(join(dir, SUPERVISOR_LOCK_FILE), "{not json\n", { mode: 0o600 });
  chmodSync(join(dir, SUPERVISOR_LOCK_FILE), 0o600);
  assert.throws(
    () => inspectSupervisorLock(spool),
    isInbox("INBOX_LOCK_CORRUPT", 3),
  );
  assert.throws(
    () => acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW }),
    isInbox("INBOX_LOCK_CORRUPT", 3),
  );
  assert.equal(forceClearSupervisorLock(spool), true);
  assert.equal(inspectSupervisorLock(spool).state, "absent");

  const target = join(dir, "outside-lock.json");
  writeFileSync(target, `${JSON.stringify(lockRecord())}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  symlinkSync(target, join(dir, SUPERVISOR_LOCK_FILE));
  assert.throws(
    () => inspectSupervisorLock(spool),
    isInbox("INBOX_LOCK_CORRUPT", 3),
  );
  assert.throws(
    () => forceClearSupervisorLock(spool),
    isInbox("INBOX_LOCK_CORRUPT", 3),
  );
});

test("force recovery removes a corrupt guard path before clearing a corrupt lock", () => {
  const dir = newDir("force-corrupt-guard");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  writeRecord(join(dir, SUPERVISOR_LOCK_FILE), { not: "a lock" });
  symlinkSync(join(dir, "missing-guard-target"), join(dir, SUPERVISOR_GUARD_DIR));

  assert.equal(forceClearSupervisorLock(spool), true);
  assert.equal(inspectSupervisorLock(spool).state, "absent");
  assert.equal(existsSync(join(dir, SUPERVISOR_GUARD_DIR)), false);
});

test("status cursor observation is safe and read-only", () => {
  const dir = newDir("cursor");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  assert.equal(readCursorAfterSeq(spool), 0);

  writeFileSync(
    join(dir, "cursor.json"),
    `${JSON.stringify({
      version: 1,
      project_id: PROJECT,
      speaker_id: "spk_poller",
      base_url: BASE,
      after_seq: 7,
      updated_at: NOW().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(join(dir, "cursor.json"), 0o600);
  assert.equal(readCursorAfterSeq(spool), 7);

  writeFileSync(join(dir, "cursor.json"), "{not json\n", { mode: 0o600 });
  chmodSync(join(dir, "cursor.json"), 0o600);
  assert.equal(readCursorAfterSeq(spool), null);
});

test("a reclaimer holding a stale inspection cannot delete a newer live lock", () => {
  const dir = newDir("reclaim-race");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  const staleRecord = lockRecord({
    instance: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    boot_id: "boot-from-a-previous-boot",
  });
  writeLock(dir, staleRecord);

  // Reclaimer B inspects the stale record and then pauses. Reclaimer A moves
  // that record aside and installs a live R2 in the meantime.
  const stale = inspectSupervisorLock(spool);
  assert.equal(stale.state, "stale");
  assert.ok(stale.record !== undefined);
  const live = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  const liveInstance = live.record.instance;
  assert.notEqual(liveInstance, stale.record.instance);

  // B now reclaims with its old expectation. It must restore R2, not delete it.
  assert.equal(reclaimStaleSupervisorLock(spool, stale.record), false);
  const afterRace = inspectSupervisorLock(spool);
  assert.equal(afterRace.state, "live");
  assert.equal(afterRace.record?.instance, liveInstance);
  assert.deepEqual(
    readdirSync(spool.root).filter((name) => name.startsWith(`${SUPERVISOR_LOCK_FILE}.stale-`)),
    [],
  );
  live.release();
  assert.equal(inspectSupervisorLock(spool).state, "absent");
});

test("an unreadable /proc identity fails closed instead of reclaiming a live lock", () => {
  const dir = newDir("proc-eacces");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  writeLock(
    dir,
    lockRecord({ instance: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", process_start: "999" }),
  );
  const probe = {
    processStart: () => ({ state: "unreadable" as const }),
    pidAlive: () => true,
  };
  assert.equal(inspectSupervisorLock(spool, probe).state, "live");
  assert.throws(
    () => acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW, probe }),
    isInbox("INBOX_LOCKED", 1),
  );
  assert.equal(inspectSupervisorLock(spool, probe).state, "live");
  assert.equal(
    inspectSupervisorLock(spool, probe).record?.instance,
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );

  const goneProbe = {
    processStart: () => ({ state: "gone" as const }),
    pidAlive: () => true,
  };
  assert.equal(inspectSupervisorLock(spool, goneProbe).state, "stale");
});

test("read-only status open never creates or repairs spool directories", () => {
  const dir = newDir("readonly-open");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  rmSync(spool.tmpDir, { recursive: true, force: true });
  assert.throws(
    () => openSpool(dir, {}, true),
    isInbox("INBOX_CONFIG", 2),
  );
  assert.equal(existsSync(spool.tmpDir), false);

  // The ordinary writer path still creates the missing directory.
  assert.equal(existsSync(openSpool(dir).tmpDir), true);
});

test("out-of-order arrivals are delivered in sequence order with contiguous acks", () => {
  const dir = newDir("reorder");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  registerConsumer(spool, "consumer-a");
  for (const seq of [3, 1, 2]) {
    enqueueEvent(spool, message(seq), null, { token: TOKEN, now: NOW });
  }
  assert.deepEqual(
    pendingEvents(spool, "consumer-a").map((event) => event.seq),
    [1, 2, 3],
  );
  assert.equal(ackEvent(spool, "consumer-a", 1).acked_seq, 1);
  assert.equal(ackEvent(spool, "consumer-a", 2).acked_seq, 2);
  assert.equal(ackEvent(spool, "consumer-a", 3).acked_seq, 3);
  assert.deepEqual(pendingEvents(spool, "consumer-a"), []);
});

function runNodeEval(
  code: string,
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("two simultaneous processes reclaiming a stale lock leave exactly one live winner", async () => {
  const dir = newDir("two-process-reclaim");
  prepareSpool(dir, PROJECT, { now: NOW });
  writeLock(
    dir,
    lockRecord({
      instance: "cccccccccccccccccccccccccccccccc",
      boot_id: "boot-from-a-previous-boot",
    }),
  );
  const moduleUrl = new URL("../../src/inbox/index.ts", import.meta.url).href;
  const code = `
import {
  InboxError,
  acquireSupervisorLock,
  inspectSupervisorLock,
  prepareSpool,
} from ${JSON.stringify(moduleUrl)};
import { setTimeout as delay } from "node:timers/promises";
const dir = process.env.SPOOL_DIR;
await delay(150);
const spool = prepareSpool(dir, "proj_1", { sweep: false });
let lock;
try {
  lock = acquireSupervisorLock(spool, { baseUrl: "http://127.0.0.1:9" });
} catch (error) {
  if (error instanceof InboxError && error.code === "INBOX_LOCKED") {
    process.stdout.write("locked\\n");
  } else {
    throw error;
  }
}
if (lock !== undefined) {
  process.stdout.write("acquired\\n");
  await delay(800);
  const current = inspectSupervisorLock(spool);
  process.stdout.write(
    current.state === "live" && current.record?.instance === lock.record.instance
      ? "still-live\\n"
      : "lost\\n",
  );
  lock.release();
}
`;
  const [first, second] = await Promise.all([
    runNodeEval(code, { SPOOL_DIR: dir }),
    runNodeEval(code, { SPOOL_DIR: dir }),
  ]);
  const outputs = [first.stdout, second.stdout];
  assert.equal(outputs.filter((output) => output.includes("acquired")).length, 1);
  assert.equal(outputs.filter((output) => output.includes("locked")).length, 1);
  assert.equal(outputs.some((output) => output.includes("lost")), false);
  assert.equal(
    outputs.some((output) => output.includes("Error")),
    false,
    `${first.stderr}\n${second.stderr}`,
  );
  assert.equal(inspectSupervisorLock(openSpool(dir)).state, "absent");
});

test("a three-party reclaim race cannot delete the live canonical lock", () => {
  const dir = newDir("three-party");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  writeLock(
    dir,
    lockRecord({
      instance: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      boot_id: "boot-from-a-previous-boot",
    }),
  );
  // P2 inspects stale R1 and pauses before reclaiming.
  const p2 = inspectSupervisorLock(spool);
  assert.equal(p2.state, "stale");
  assert.ok(p2.record !== undefined);

  // P1 serially reclaims R1 and links live R2, then starts polling.
  const p1 = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  const liveInstance = p1.record.instance;

  // P2 resumes with its stale expectation. While P2 has moved R2 aside and
  // holds the guard, P3 must not be able to link R3.
  assert.equal(
    reclaimStaleSupervisorLock(spool, p2.record, () => {
      assert.throws(
        () => acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW }),
        isInbox("INBOX_LOCKED", 1),
      );
    }),
    false,
  );
  assert.equal(inspectSupervisorLock(spool).record?.instance, liveInstance);

  // P3 cannot acquire; P1 remains the only poller.
  assert.throws(
    () => acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW }),
    isInbox("INBOX_LOCKED", 1),
  );
  assert.equal(inspectSupervisorLock(spool).state, "live");
  assert.equal(inspectSupervisorLock(spool).record?.instance, liveInstance);
  assert.deepEqual(
    readdirSync(spool.root).filter(
      (name) => name.includes(".stale-") || name.includes(".quarantine-"),
    ),
    [],
  );
  p1.release();
});

test("a restore conflict quarantines and never unlinks the unverified moved record", () => {
  const dir = newDir("restore-conflict");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  writeLock(
    dir,
    lockRecord({
      instance: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      boot_id: "boot-from-a-previous-boot",
    }),
  );
  const staleInspection = inspectSupervisorLock(spool);
  assert.equal(staleInspection.state, "stale");
  assert.ok(staleInspection.record !== undefined);
  const staleR1 = staleInspection.record;
  const p1 = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  const movedInstance = p1.record.instance;

  assert.throws(
    () =>
      reclaimStaleSupervisorLock(spool, staleR1, () => {
        // An unsupported writer bypasses the guard and links R3 while P2 has
        // moved R2 aside. P2 must not unlink the record it moved.
        writeLock(
          dir,
          lockRecord({ instance: "abababababababababababababababab" }),
        );
      }),
    isInbox("INBOX_LOCKED", 1),
  );

  const canonical = inspectSupervisorLock(spool);
  assert.equal(canonical.state, "live");
  assert.equal(canonical.record?.instance, "abababababababababababababababab");
  const quarantined = readdirSync(spool.root).filter((name) =>
    name.startsWith(`${SUPERVISOR_LOCK_FILE}.quarantine-`),
  );
  assert.equal(quarantined.length, 1);
  const moved = JSON.parse(
    readFileSync(join(spool.root, quarantined[0] ?? ""), "utf8"),
  ) as { instance: string };
  assert.equal(moved.instance, movedInstance);
  p1.release();
});

function writeRecord(path: string, record: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test("an old guard with a live stopped owner blocks and is not displaced", async (t) => {
  const dir = newDir("guard-live-stopped");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => stopChild(child, "SIGKILL"));
  await waitFor(() => child.pid !== undefined && processStart(child.pid) !== null);
  const pid = child.pid;
  assert.ok(pid !== undefined);
  stopChild(child, "SIGSTOP");
  await waitFor(() => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("T");
  });

  const guardDir = join(dir, SUPERVISOR_GUARD_DIR);
  mkdirSync(guardDir, { mode: 0o700 });
  const owner = {
    version: 1,
    instance: "dddddddddddddddddddddddddddddddd",
    pid,
    boot_id: bootId(),
    process_start: processStart(pid),
    acquired_at: NOW().toISOString(),
  };
  writeRecord(join(guardDir, "owner.json"), owner);
  // Older than the age threshold: identity, not age, must decide.
  const old = new Date(Date.now() - 10 * GUARD_STALE_MS);
  utimesSync(guardDir, old, old);

  assert.throws(
    () => acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW }),
    isInbox("INBOX_LOCKED", 1),
  );
  assert.equal(existsSync(guardDir), true);
  assert.equal(
    (JSON.parse(readFileSync(join(guardDir, "owner.json"), "utf8")) as { instance: string })
      .instance,
    owner.instance,
  );

  // Once the owner is provably dead, the same guard is reclaimed.
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  stopChild(child, "SIGKILL");
  await exited;
  await waitFor(() => processStart(pid) === null);
  const lock = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  lock.release();
  assert.equal(existsSync(guardDir), false);
});

test("the startup sweep keeps a fresh live tombstone and removes dead or old ones", () => {
  const dir = newDir("sweep-tombstone");
  const spool = prepareSpool(dir, PROJECT, { now: NOW });
  const liveTombstone = join(dir, `${SUPERVISOR_LOCK_FILE}.stale-live`);
  const deadTombstone = join(dir, `${SUPERVISOR_LOCK_FILE}.stale-dead`);
  // A crash between rename and restore can leave a live record here.
  writeRecord(liveTombstone, lockRecord());
  writeRecord(
    deadTombstone,
    lockRecord({ pid: 2_147_483_647, process_start: "1" }),
  );

  const first = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  first.release();
  assert.equal(existsSync(liveTombstone), true);
  assert.equal(existsSync(deadTombstone), false);

  const old = new Date(Date.now() - 10 * GUARD_STALE_MS);
  utimesSync(liveTombstone, old, old);
  const second = acquireSupervisorLock(spool, { baseUrl: BASE, now: NOW });
  second.release();
  assert.equal(existsSync(liveTombstone), false);
});

test("concurrent acquire/release loops never report two live owners", async () => {
  const dir = newDir("acquire-loop");
  prepareSpool(dir, PROJECT, { now: NOW });
  const moduleUrl = new URL("../../src/inbox/index.ts", import.meta.url).href;
  const code = `
import {
  InboxError,
  acquireSupervisorLock,
  inspectSupervisorLock,
  prepareSpool,
} from ${JSON.stringify(moduleUrl)};
import { setTimeout as delay } from "node:timers/promises";
const spool = prepareSpool(process.env.SPOOL_DIR, "proj_1", { sweep: false });
let count = 0;
for (let iteration = 0; iteration < 15; iteration += 1) {
  let lock;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      lock = acquireSupervisorLock(spool, { baseUrl: "http://127.0.0.1:9" });
      break;
    } catch (error) {
      if (error instanceof InboxError && error.code === "INBOX_LOCKED") {
        await delay(2);
        continue;
      }
      throw error;
    }
  }
  if (lock === undefined) throw new Error("could not acquire");
  const current = inspectSupervisorLock(spool);
  if (!(current.state === "live" && current.record?.instance === lock.record.instance)) {
    process.stdout.write("lost\\n");
    process.exit(1);
  }
  count += 1;
  await delay(2);
  lock.release();
  await delay(1);
}
process.stdout.write("ok=" + count + "\\n");
`;
  const runs = await Promise.all([
    runNodeEval(code, { SPOOL_DIR: dir }),
    runNodeEval(code, { SPOOL_DIR: dir }),
    runNodeEval(code, { SPOOL_DIR: dir }),
  ]);
  for (const run of runs) {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.includes("ok=15"), true, run.stdout);
    assert.equal(run.stdout.includes("lost"), false);
  }
  assert.equal(inspectSupervisorLock(openSpool(dir)).state, "absent");
});
