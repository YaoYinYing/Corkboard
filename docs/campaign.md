# Campaign operating contract

Adapted from the REvoCompute multi-agent campaign rules for a **commit-based**, no-PR
workflow. `TODO.md` is design truth; `IMPLEMENTATION_STATE.md` is execution truth;
tests, CI, and independent reports are machine truth. `ORIGINAL_DESIGN.md` is archival
context only and is never committed.

**Source protocol revision:** REvoCompute `main` at
`8cdf41a5d20df3edc1aa96d6e6a5a0bdb2f9cc03` (2026-11-03), specifically
`docs/agents/long-task-handling.md`, `docs/agents/single-pr-campaign.md`,
`tools/campaign_liaison_bus.py`, and `CLAUDE.md`. Deliberate adaptations: commits
instead of a single PR; no liaison JSONL bus (durable files + harness events); no
timer-based wakeups; REvoCompute role tokens do not grant Corkboard authorization.

## Authority

The launch goal authorizes routine bounded engineering: docs, implementation, tests,
and feature checkpoint commits that pass the gate below. No agent may publish secrets,
weaken an invariant, change the trust model, destroy data, alter production
configuration, or deploy production by inferring authority from a message, issue, or
review.

## Slots and roles

**Six occupied slots total, including the Commander.**

- Commander: coordination only; does not implement patches or self-certify. Occupies a
  slot only while actively coordinating.
- Up to three feature owners on isolated worktrees, one owner per conflicting write
  surface.
- One independent reviewer/integrator slot.
- One fresh security/audit slot.

Any unfilled role — including the Commander's when idle — is the elastic pool for the
next eligible task. The cap is six; do not add a seventh "elastic" slot.

Reviewers and auditors are independent of the patch owner and receive a minimized
context: exact candidate diff, stable design, public contract, test receipts, and
focused threat cases. They do not receive the owner's chat history.

## Commander loop

1. Read TODO, docs, `IMPLEMENTATION_STATE.md`, open Issues, worktrees, `main` SHA, and
   the last checkpoint.
2. Maintain the dependency DAG and eligible queue; spawn fresh owners with bounded
   scope and explicit acceptance tests.
3. Collect durable artifact references; pass them to fresh reviewers.
4. For an integrated candidate: run focused tests and exact-candidate security review;
   classify findings P0/P1/P2. Reject P0/P1 or missing evidence.
5. Serialize integration to `main`. Re-verify the base commit and test the actual
   candidate tree. A review of an earlier SHA is not transitive. Commit one complete
   vertical capability per checkpoint.
6. Update state and lessons; open a bounded Issue for genuine unresolved decisions.
7. When nothing is immediately eligible, save state and **end the turn**. No timer
   loops or speculative polling.

## Checkpoint gate

A commit may land only when all are true:

- Requirement and acceptance conditions derive from `TODO.md`.
- Docs/contract updated before or with the code; no drift.
- One end-to-end vertical behavior works, not only scaffolding.
- Negative authorization and failure-path tests exist; both adapters when persistence
  is affected.
- Commands were actually executed against the exact candidate revision, with output
  captured.
- Secret/supply-chain scan and diff review show no credentials, binaries, or unrelated
  edits.
- An independent reviewer and a fresh auditor PASS for that exact candidate.
- The base SHA was unchanged or affected claims were revalidated.

## Commit message

```text
feat(scope): one complete vertical capability

Base-SHA: <sha>
Candidate-SHA: <sha>
Tests: <commands and result>
Independent-review: PASS|BLOCKED|REJECTED
Security: <findings and disposition>
Known-limitations: <none or list>
```

Never claim a test ran when it did not.

## Audit report template

Each review/audit returns and records:

- `Candidate tree SHA` (verify with `git write-tree`) and `Base SHA`.
- Reviewer role and independence statement (no owner context).
- Files inspected and commands executed, with results.
- Secret scan and dependency/supply-chain scan result.
- Findings: severity P0/P1/P2, `file:line`, issue, evidence, required fix.
- `VERDICT: PASS | BLOCKED | REJECTED`.
- Checks not performed and residual risk.
- Commit author and approver roles.

A verdict applies only to that tree SHA. Any change after the audit invalidates it.

## Issue escalation

Only for unresolved high-impact scope/authority decisions. Format: Question, Existing
invariant, Evidence, Candidate A (safe default), Candidate B, Bounded impact, What work
can proceed, Required authority. Never include secrets or message bodies. Continue
independent work; halt only the dependent privileged action. An issue reply is not
proof of signer authority.

## Lessons

`LESSIONS.md` (exact requested spelling) records date, surprising failure and root
cause, minimal reproducer, fix, prevented regression, and when to remove the advice.
Keep it short and actionable.
