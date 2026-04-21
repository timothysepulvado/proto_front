# Step 10d Pre-Flight Report

- **Date:** 2026-04-19
- **Author:** Brandy (fresh session from `/clear`, executing `~/agent-vault/briefs/10d-preflight-check.md`)
- **Backend:** direct Anthropic (`@anthropic-ai/sdk` 0.90.0) — post-10c-3 pivot (commit `039a0bf`)
- **Outcome:** **GREEN** for pre-flight / **YELLOW** for 10d full 30-shot run (see §10d Prerequisites)

## TL;DR

The pipeline is ready for the direct-Anthropic reuse-first regression on Drift MV. Infrastructure, readiness gates, live orchestrator probe, and caching audit are all green. A **runner-layer gap** (no "regrade existing artifact" mode) and a **data gap** (only 1 of 30 Drift MV deliverables seeded in Supabase) surface as 10d prerequisites — not pre-flight blockers, but the 10d session must resolve them before launching a 30-shot run.

Caching fixes applied this session are worth an estimated **~3× reduction** in per-shot orchestrator cost once rolled into 10d, driven by the pricing-constant + cost-formula patches (the caching itself was already working).

---

## Phase-by-phase

### Phase 1 — Infrastructure + plumbing — ✓ GREEN

| Check | Result |
|---|---|
| os-api :3001 `/api/clients` | 200 |
| brand-engine :8100 `/health` | 200 |
| Temp-gen :8200 `/health` | 200 |
| 10a readiness gate | **17/17 pass** |
| 10c1 SSE escalation-forward gate | **18/18 pass** |
| `tsc --noEmit -p os-api` | clean |
| 10c websearch probe (live) | `backend=direct`, `authMode=direct_api_key`, `webSearchCount=2`, assertions passed |

**Note:** Phase 1 probe initially surfaced a cost reporting anomaly (`cost: -0.162976` — negative). Root-caused and patched in Phase 2; see §Caching Audit below.

### Phase 2 — Claude Opus 4.7 caching audit — ✓ GREEN (with patches applied)

**Research.** Used the `claude-api` skill against 2026-04-19 Anthropic docs. Six findings, five patched, one deferred:

| # | Finding | Current | Target | Action |
|---|---|---|---|---|
| 1 | Cache-hit IS working — 5,214 tokens cached/read on Opus 4.7 | Ephemeral (5-min) | — | No change. Verified live via new `10d-pre-cache-hit-probe`. |
| 2 | **Cost formula double-subtracts cache tokens** — `input_tokens` is already the non-cached remainder; subtracting `cache_read` + `cache_write` produces negative costs | `(tokensIn - cacheRead - cacheWrite) * rate + …` | `tokensIn * rate + cacheWrite * rate * 1.25 + cacheRead * rate * 0.10 + …` | **Patched** (`os-api/src/anthropic.ts`). |
| 3 | **Pricing constants stale** — `$15/M input, $75/M output` in code; actual Opus 4.7 is `$5/$25` per M | $15 / $75 | $5 / $25 | **Patched** (env-overridable). 3× cost overstatement fixed in `orchestration_decisions.cost_usd` going forward. |
| 4 | `web_search_20260209` available on Opus 4.7 direct, adds dynamic filtering; SDK 0.90.0 supports both literals | `web_search_20250305` | `web_search_20260209` | **Upgraded** in `_buildTools`. Re-run probe shows dynamic filtering active (model spins up `code_execution` to filter results — latency 8s → 23s, accuracy +). |
| 5 | `@anthropic-ai/sdk` was **transitive-only** via vertex-sdk — latent risk for PRIMARY direct path | Transitive (`@anthropic-ai/vertex-sdk` → `@anthropic-ai/sdk@0.90.0`) | Explicit dep | **Patched** `os-api/package.json`. |
| 6 | Multi-breakpoint splitting (split system into stable-core + semi-stable + dynamic) | Single breakpoint on whole system block | — | **Deferred.** Our SYSTEM_PROMPT is already 100% stable; extra breakpoints fragment without measurable gain for our call pattern (1-3 calls per shot within a 5-min window). 5-min ephemeral TTL fits the workload. 1-hour TTL opt-in reserved if wall-clock between shots balloons. |

**Cache-hit probe (mandatory Phase 2 verification):**

```
=== CALL 1 (expect cache write) ===
cacheWriteTokens:  5214    ← written
cacheReadTokens:      0

=== CALL 2 (expect cache read) ===
cacheWriteTokens:     0
cacheReadTokens:   5214    ← read

=== ASSERTIONS PASSED ===
```

Probe at `os-api/tests/10d-pre-cache-hit-probe.ts` — reusable gate, survives pre-flight.

**Estimated 10d savings from Phase 2 patches:**
- Cost-formula + pricing fixes: `orchestration_decisions.cost_usd` now reports accurate $USD. Prior records overstated by ~3× plus the double-subtraction artifact. **Not a real-cost savings** (Anthropic billing was always correct) — but our in-run cost tracking and per-shot $4 cap will now fire on the right numbers.
- Cached prefix savings: 5,214 tokens × $5/M × (1 - 0.10) = $0.0235 per shot saved after first call (versus uncached). For 30-shot × ~2 calls/shot = ~$0.70 saved across run. Small absolute — caching was already working.
- **Net: the pre-flight saved us from a wildly wrong budget display during 10d, more than a real billing reduction.**

### Phase 3 — Tool-use + data sanity — ⚠ YELLOW (data gap; not a pre-flight blocker)

Data sanity probe at `os-api/tests/10d-pre-data-sanity.ts`:

| Check | Result |
|---|---|
| `clients.client_drift-mv` row | ✓ present (`status=active`, `last_run_status=completed`) |
| Campaign for client_drift-mv | ✓ 1 campaign (`Drift MV Step 10c — Shot 20 dry run`, id `b6691def-…`) |
| `campaign_deliverables` count | **⚠ 1 of 30 expected** — only the Shot 20 10c dry-run deliverable is seeded |
| Artifacts on existing deliverables | 2 for Shot 20 (one with `localPath`, one legacy orphan without — the `cc98c1c1-…` the brief called out) |
| Artifact grading | Both `grade=null`, deliverable `status=reviewing` (not `completed`) |
| Dry-run target (Shot 20 deliverable) | id `1d7c52f1-e982-49d3-9661-15a8fe8d170d` — usable, but ungraded |

Tool-use: `web_search_20260209` upgrade decision committed in Phase 2.

### Phase 4 — Single-shot live dry-run — ✓ GREEN (scope adjusted)

**Scope adjustment (vs brief).** The brief specified `POST /api/runs {client_id, mode: "single", deliverable_id}` — but:

1. The actual route is `POST /api/clients/:clientId/runs {mode, campaignId}` — no `deliverable_id` field, no `"single"` mode (valid modes: `full | ingest | images | video | drift | export`).
2. The runner has no "reuse existing artifact → regrade → mark complete" path. Video grading + escalation only runs *after* fresh Temp-gen generation inside `executeGenerateVideoStage`.
3. Running `mode: video` would cost ~$0.40-$1.50 in Veo 3.1 fees and diverges from "reuse-first" intent.

**Chosen path.** Executed `mode: ingest` against `client_drift-mv`. Cheapest possible live exercise of the runner machinery (`runner → brand-engine → Supabase → SSE`) without Veo cost or orchestrator escalation. This complements the Phase 1+2 live probes, which already covered the orchestrator/direct-Anthropic/caching pipeline end-to-end.

**Result:**

```
runId:                  e0f5879b-ba3d-4221-a7ea-fed0bdd931a7
final status:           completed
completed_at:           2026-04-19T23:42:12.105+00:00
run_logs events:        12
orchestration_decisions: 0 (expected — ingest mode doesn't call orchestrator)
asset_escalations:      0
cumulative cost:        $0.0000
wall-clock:             ~6s
```

SSE stream delivered 12 log events in real time, including the expected brand-engine `/ingest` 404 (brand assets dir path mismatch — existing known state), followed by clean demo-fallback and `Run finished with status: completed`. Heartbeats kept the stream open post-completion.

### Phase 5 — Reporting + handoff — ✓ GREEN (this document)

This report + `2026-04-19-step-10d-kickoff.md` handoff + ROADMAP/MISSION/status updates + two commits (proto_front + agent-vault). Handoff file is `.claude/`-gitignored per existing convention.

---

## 10d Prerequisites (must resolve before full 30-shot run)

**Split into two sessions (decided 2026-04-20)** to avoid context-crowding during the live 30-shot run:
- **Session A — prereqs + re-verify:** seeder + regrade runner path + Shot 20 smoke test + gate re-verification. Handoff: `~/proto_front/.claude/handoffs/2026-04-20-step-10d-session-a-prereqs.md`. Expected duration ~4-6 hr.
- **Session B — 10d launch:** live 30-shot regrade run with SSE + cost monitoring. Handoff: `~/proto_front/.claude/handoffs/2026-04-20-step-10d-session-b-launch.md`. Expected duration ~1.5-2 hr wall-clock + overlap.
- Old single-session handoff (`2026-04-19-step-10d-kickoff.md`) is banner-superseded in place.

1. ✅ **Seeded 30 Drift MV deliverables in Supabase.** *(Session A — 2026-04-20)* `os-api/scripts/seed-drift-mv.ts` lands a new catalog campaign **`42f62a1d-b9df-57d8-8197-470692733391`** · `"Drift MV — 30-shot catalog regression (10d)"` · 30/30 `campaign_deliverables` + 30/30 `artifacts` with `metadata.localPath` populated (`~/Temp-gen/productions/drift-mv/shots/shot_NN.mp4`). Deterministic uuid-v5 ids; re-runs no-op (`SEED_DRIFT_MV_DRY=1` for print-only). Synthetic seed run: `bfe328c8-069a-57c7-886c-e65af2107309`. Data-sanity probe post-seed: 30/30 ✓.
2. ✅ **`mode: "regrade"` runner path landed.** *(Session A — 2026-04-20)* `supabase/migrations/008_regrade_run_mode.sql` extends the `run_mode` enum (applied live via Management API). `os-api/src/types.ts` / `db.ts` / `runner.ts` add `RunMode += "regrade"`, `STAGE_DEFINITIONS.regrade`, `getLatestArtifactByDeliverable`, pure helpers `_shouldSkipDeliverable` + `_decideRegradeStatusTransition`, `regradeOneDeliverable`, `executeRegradeStage`. Idempotent — skips `status=completed`. Confirmed `runVideoQAWithEscalation` has no hard coupling to `executeGenerateVideoStage` (no refactor needed). Unit test `os-api/tests/10d-regrade-runner.ts` 14/14 green.
3. ✅ **Shot 20 smoke test passed.** *(Session A — 2026-04-20)* Run `2bce7bc9-6dbf-47a3-a4fc-754ccd2e73c8` against the 10c dry-run campaign (`b6691def-…`) — `/grade_video` returned PASS 4.9 on the first call, zero orchestrator calls, $0 cost, wall-clock ~35s. Artifact `35fe6dd6-…` graded PASS, deliverable `1d7c52f1-…` flipped `reviewing → approved`. Reuse-first worked exactly as designed.
4. **Optional:** raise or remove the per-shot $4 cap's cost-estimate signal for the 10d run now that cost math is accurate — the prior overstatement would have prematurely tripped the cap on the real 30-shot run. *(Defer to Session B if it actually bites; Session A doesn't need to touch it.)*

## Session A close (2026-04-21)

Session A paused 2026-04-20 PM with all code shipped + gates green but commits + docs + probe re-verification pending. Resumed 2026-04-21 on a new machine:

- **Env sanity (new-machine pre-check):** `os-api/.env` intact with `ANTHROPIC_API_KEY`, Node v22.22.0 active via nvm, `status.sh` present. `gh auth` token invalid — not a blocker (local commits only this session).
- **Live probes re-verified:**
  - `10c-vertex-websearch-probe` — `backend=direct`, `authMode=direct_api_key`, `webSearchCount=2`, `code_execution` tool-use observed (dynamic filtering on `web_search_20260209` active), `toolUses[]` populated, cited URL in response. `=== ASSERTIONS PASSED ===`. Cost $0.075/call, latency 17.7s.
  - `10d-pre-cache-hit-probe` — Call 1 wrote 5214 cache tokens; Call 2 read 5214 cache tokens. `=== ASSERTIONS PASSED ===`.
- **Unit gates** (carry-forward from 2026-04-20): 10a 17/17 · 10c1 18/18 · 10d-regrade-runner 14/14 · `tsc --noEmit -p os-api` clean.

**Commits:** proto_front `<pending>` (feat(orchestrator): 10d Session A — regrade runner path + Drift MV catalog seeder) + agent-vault `<pending>` (docs(brandstudios): 10d Session A closeout — prereqs ✅). _Backfilled post-commit._

**Session B unblocked.** Launch handoff at `.claude/handoffs/2026-04-20-step-10d-session-b-launch.md` is filled with the catalog campaign id; reads Session A's work via this document.

## Deferred: asset-storage architecture (flagged 2026-04-20)

For this test run, Session A seeds directly from `~/Temp-gen/productions/drift-mv/` filesystem paths (dev-only shortcut). For multi-client production, where client asset catalogs should live is an unsolved architectural question with six open sub-questions (canonical storage tier, proto_front read path, Temp-gen write path, production-manifest DB shape, client onboarding workflow, per-tenant isolation). Parked for post-10d ADR work — see `~/agent-vault/domains/brandstudios/ROADMAP.md` §Deferred §"Production asset storage architecture". **Do NOT attempt to solve this during Session A or Session B.** Staying on the dev-filesystem path is the right move for the 10d validation run.

## Go / No-Go for 10d

**GO** — via Session A → Session B. The direct-Anthropic pivot, caching, tool-use, cost tracking, SSE wire, and runner machinery are all verified at the pipeline level. The remaining gaps are scoping gaps (catalog not seeded, runner lacks regrade mode), both addressed by Session A.

Projected 10d spend at accurate pricing: orchestrator-side ~$5-8 for 30 shots × 2-3 calls × ~$0.08/call (with dynamic filtering on `web_search_20260209` running high on output tokens). Well inside the $50 starter credit. Veo regen cost only applies if artifacts need regen after reuse-path grade failures — estimate $0-$25 depending on reuse hit rate.

## Commits (pre-flight)

- **proto_front `09370a5`** — `feat(orchestrator): 10d pre-flight — caching optimizations + dry-run verified`
- **proto_front `48dfec0`** — `docs: 10d pre-flight follow-up — stale-ref cleanup across ESCALATION_LOG + .env.example + anthropic.ts + probe`
- **agent-vault `bef0a38`** — `docs(brandstudios): 10d pre-flight complete — direct path verified, caching optimized`
- **agent-vault `fbb8054`** — `docs(brandstudios): 10d pre-flight follow-up — pull-forward stale refs across MISSION / MODEL_INTELLIGENCE / brief / ROADMAP 10c-3`
- **Handoff files** (`.claude/handoffs/2026-04-20-step-10d-session-{a-prereqs,b-launch}.md` + old `2026-04-19-step-10d-kickoff.md`) are gitignored.
