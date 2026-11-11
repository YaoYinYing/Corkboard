import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ackEvent,
  acknowledgedSeq,
  enqueueEvent,
  openSpool,
  prepareSpool,
  pruneSpool,
  registerConsumer,
  type InboxMessageInput,
} from "../../src/inbox/spool.ts";

const root = mkdtempSync(join(tmpdir(), "corkboard-inbox-ack-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

const CLI = fileURLToPath(new URL("../../scripts/inbox.ts", import.meta.url));
const TOKEN = "synthetic-inbox-token";

function message(seq: number): InboxMessageInput {
  return {
    projectId: "proj_1",
    messageId: `msg_${seq}`,
    seq,
    senderId: "spk_sender",
    summary: `summary ${seq}`,
    bodyState: "ready",
  };
}

function ack(spoolDir: string, consumer: string, seq: number) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      CLI,
      "ack",
      "--spool-dir",
      spoolDir,
      "--consumer",
      consumer,
      "--seq",
      String(seq),
    ],
    { encoding: "utf8" },
  );
}

test("ack seeds a pruned prefix for a consumer registered later", () => {
  const dir = join(root, "late-consumer");
  const spool = prepareSpool(dir, "proj_1", { plaintext: false });
  registerConsumer(spool, "early");
  enqueueEvent(spool, message(1), null, { token: TOKEN });
  enqueueEvent(spool, message(2), null, { token: TOKEN });
  ackEvent(spool, "early", 1);
  ackEvent(spool, "early", 2);
  assert.equal(pruneSpool(spool, { force: true }), 2);

  enqueueEvent(spool, message(3), null, { token: TOKEN });
  enqueueEvent(spool, message(4), null, { token: TOKEN });
  registerConsumer(spool, "late");

  const result = ack(dir, "late", 3);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(acknowledgedSeq(openSpool(dir), "late"), 3);

  // A retained event still cannot be skipped: seq 4 is only reachable in order.
  const skipped = ack(dir, "late", 5);
  assert.notEqual(skipped.status, 0);
  assert.match(skipped.stderr, /skip/);
  assert.equal(acknowledgedSeq(openSpool(dir), "late"), 3);
});

test("ack never seeds for a target event that does not exist", () => {
  const dir = join(root, "absent-target");
  const spool = prepareSpool(dir, "proj_1", { plaintext: false });
  registerConsumer(spool, "early");
  enqueueEvent(spool, message(1), null, { token: TOKEN });
  ackEvent(spool, "early", 1);
  assert.equal(pruneSpool(spool, { force: true }), 1);
  registerConsumer(spool, "late");

  const result = ack(dir, "late", 5);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skip/);
  // Without the existence gate the seed would have advanced the watermark to 4.
  assert.equal(acknowledgedSeq(openSpool(dir), "late"), 0);
});
