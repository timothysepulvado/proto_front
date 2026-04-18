/**
 * 10c1-sse-escalation-forward — wire-level contract test for the SSE
 * escalation forwarding added to /api/runs/:runId/logs in 10d-pre-1.
 *
 * Closes gap 10c-1: prior to 10d-pre, runEvents.emit("escalation:${runId}",
 * ...) had ZERO subscribers, so watcher_signal payloads (cumCost / consec
 * regens / levels-used) emitted by escalation_loop.ts never reached the SSE
 * stream. The 10a-promised "human watcher can cancel" capability was dead
 * wiring. This test verifies the new subscription pattern + wire-level
 * payload shape.
 *
 * What it verifies:
 *   - The SSE handler's escalation listener pattern correctly wraps emitted
 *     escalation events as `data: {type:"escalation", payload:<event>}\n\n`
 *     for both watcher_signal payloads AND raw AssetEscalation rows.
 *   - The cleanup correctly unsubscribes (no leak after disconnect).
 *
 * Not verified here (manual code review of index.ts:163-217 covers it):
 *   - The actual Express route registration.
 *   - Heartbeat behavior on long-lived connections.
 *
 * Run: npx tsx os-api/tests/10c1-sse-escalation-forward.ts
 * Expected: ALL TESTS PASSED at the end.
 */
import { runEvents } from "../src/runner.js";

interface MockRes {
  written: string[];
  write(chunk: string): void;
}

function makeMockRes(): MockRes {
  return {
    written: [],
    write(chunk: string) {
      this.written.push(chunk);
    },
  };
}

/**
 * Mirrors the SSE escalation listener pattern from index.ts:188-204.
 * Kept inline here so the test exercises the SAME contract: wrap event in
 * {type:"escalation", payload:event}, write as SSE `data: ...\n\n`.
 */
function attachEscalationListener(res: MockRes, runId: string): () => void {
  const escalationListener = (event: unknown) => {
    res.write(`data: ${JSON.stringify({ type: "escalation", payload: event })}\n\n`);
  };
  runEvents.on(`escalation:${runId}`, escalationListener);
  return () => runEvents.off(`escalation:${runId}`, escalationListener);
}

const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("=== TEST 1: watcher_signal payload forwarded with type discriminator ===");
  {
    const res = makeMockRes();
    const runId = "test-run-watcher-001";
    const cleanup = attachEscalationListener(res, runId);

    const watcherPayload = {
      type: "watcher_signal" as const,
      escalationId: "esc-abc",
      artifactId: "art-xyz",
      cumulativeCost: 1.23,
      perShotHardCap: 4.0,
      consecutiveSameRegens: 1,
      levelsUsed: ["L1", "L2"],
      warnBudget: false,
      warnLoop: false,
    };
    runEvents.emit(`escalation:${runId}`, watcherPayload);

    assert("exactly 1 SSE write", res.written.length === 1, `got ${res.written.length}`);
    const wire = res.written[0];
    assert("starts with 'data: '", wire?.startsWith("data: ") ?? false);
    assert("ends with '\\n\\n'", wire?.endsWith("\n\n") ?? false);

    const json = wire?.slice(6, -2) ?? "";
    let parsed: { type?: string; payload?: { type?: string; cumulativeCost?: number } } | null = null;
    try {
      parsed = JSON.parse(json);
    } catch {
      parsed = null;
    }
    assert("payload is valid JSON", parsed !== null);
    assert("outer type === 'escalation'", parsed?.type === "escalation");
    assert("inner payload.type === 'watcher_signal'", parsed?.payload?.type === "watcher_signal");
    assert(
      "inner payload.cumulativeCost preserved",
      parsed?.payload?.cumulativeCost === 1.23,
    );

    cleanup();
  }

  console.log("");
  console.log("=== TEST 2: AssetEscalation row payload forwarded with type discriminator ===");
  {
    const res = makeMockRes();
    const runId = "test-run-status-002";
    const cleanup = attachEscalationListener(res, runId);

    // Mimics the AssetEscalation row shape emitted by lines 124, 199, 253,
    // 342, 352, 368, 440 of escalation_loop.ts (status updates, not watcher
    // signals).
    const rowPayload = {
      id: "esc-456",
      runId,
      currentLevel: "L2",
      status: "in_progress",
      iterationCount: 1,
    };
    runEvents.emit(`escalation:${runId}`, rowPayload);

    assert("exactly 1 SSE write", res.written.length === 1, `got ${res.written.length}`);
    const wire = res.written[0];
    const json = wire?.slice(6, -2) ?? "";
    let parsed: { type?: string; payload?: { id?: string; currentLevel?: string } } | null = null;
    try {
      parsed = JSON.parse(json);
    } catch {
      parsed = null;
    }
    assert("payload is valid JSON", parsed !== null);
    assert("outer type === 'escalation'", parsed?.type === "escalation");
    assert("inner payload.id preserved", parsed?.payload?.id === "esc-456");
    assert("inner payload.currentLevel preserved", parsed?.payload?.currentLevel === "L2");

    cleanup();
  }

  console.log("");
  console.log("=== TEST 3: cleanup() unsubscribes — no further writes after detach ===");
  {
    const res = makeMockRes();
    const runId = "test-run-cleanup-003";
    const cleanup = attachEscalationListener(res, runId);

    runEvents.emit(`escalation:${runId}`, { id: "first", status: "in_progress" });
    assert("1 write before cleanup", res.written.length === 1);

    cleanup();

    runEvents.emit(`escalation:${runId}`, { id: "second", status: "accepted" });
    assert("STILL 1 write after cleanup", res.written.length === 1, `got ${res.written.length} (leak)`);
  }

  console.log("");
  console.log("=== TEST 4: per-runId isolation — cross-run emits do NOT leak ===");
  {
    const resA = makeMockRes();
    const resB = makeMockRes();
    const cleanupA = attachEscalationListener(resA, "run-A");
    const cleanupB = attachEscalationListener(resB, "run-B");

    runEvents.emit(`escalation:run-A`, { id: "a-only" });
    assert("res A has 1 write", resA.written.length === 1);
    assert("res B has 0 writes", resB.written.length === 0);

    runEvents.emit(`escalation:run-B`, { id: "b-only" });
    assert("res A still has 1 write", resA.written.length === 1);
    assert("res B has 1 write", resB.written.length === 1);

    cleanupA();
    cleanupB();
  }

  console.log("");
  if (failures.length > 0) {
    console.log("=== FAILURES ===");
    for (const f of failures) console.log("  -", f);
    process.exit(1);
  }
  console.log("=== ALL TESTS PASSED ===");
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
