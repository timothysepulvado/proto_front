# Brand Studios Integration Audit — 2026-04-07

## Purpose

Post-scoreboard update. The [2026-03-31 audit](INTEGRATION_AUDIT_2026-03-31.md) identified 14 integration seams.
Since then, 8 critical fixes were shipped (commits `b4d4fac` through `b7118ce` + BDE `260037e`).
This audit reflects the current state.

---

## Repos Audited

| Repo | Role | Stack |
|------|------|-------|
| **proto_front** | HUD + os-api backend + Python worker | React + Vite + Express + Supabase |
| **BDE** | Brand DNA Engine (ML worker + linter API) | Python + Node.js (sidelined) |
| **Brand_linter** | Standalone brand compliance CLI | Python + Node.js |
| **Temp-gen** | Image/video generation CLI | Python (Gemini, Veo, Sora) |

---

## Integration Seam Scorecard

| # | Integration Seam | Status | Evidence |
|---|-------------------|--------|----------|
| 1 | proto_front HUD → Supabase | **CONNECTED** | Publishable key verified, clients + campaigns returned |
| 2 | proto_front os-api → Supabase | **CONNECTED** | `db.ts` rewritten to Supabase client (`b4d4fac`) |
| 3 | ~~SQLite ↔ Supabase sync~~ | **RESOLVED** | No longer needed — os-api writes Supabase directly |
| 4 | os-api runner → Brand_linter ingest | **CONNECTED** | Per-brand data dirs created (`260037e`), CLI wired |
| 5 | os-api runner → Temp-gen generate | **WIRED** | CLI exists, args match, venv OK |
| 6 | os-api runner → Brand_linter drift | **CONNECTED** | `--profile` flag now passed (`cd65bbd`), RAG similarity enabled |
| 7 | Brand_linter → Pinecone | **CONNECTED** | 20 indexes, JK fully populated, Cylndr CLIP populated |
| 8 | BDE retriever → Pinecone | **WIRED (dormant dim bug)** | Dormant — runner calls Brand_linter, not BDE |
| 9 | BDE linter-api → ml-worker | **BROKEN** | `node_modules` missing, requires local Postgres |
| 10 | proto_front → BDE | **DISCONNECTED** | Runner calls Brand_linter directly, BDE sidelined |
| 11 | Temp-gen output → drift check | **CONNECTED** | Runner chains stages, drift now has RAG via --profile |
| 12 | HITL: HUD → Supabase → BDE RL | **CONNECTED** | Runner writes `hitl_decisions` to Supabase (`cd65bbd`), RL trainer reads from Supabase (`260037e`) |
| 13 | Supabase Realtime → HUD | **CONNECTED** | db.ts writes Supabase, Realtime subscriptions active |
| 14 | Schema alignment | **SYNCED** | Migration 002 (`e12f5f5`) aligns codebase with live DB |
| 15 | Runtime memory retrieval | **CONNECTED** | Runner queries Pinecone before generation (`17dd313`) |
| 16 | Campaign prompt propagation | **CONNECTED** | Runner loads campaign prompt from Supabase, passes to generate + drift (`e12f5f5`) |
| 17 | Prompt evolution pipeline | **CONNECTED** | Templates, scoring, auto-evolution, lineage tracking (`b7118ce`) |
| 18 | Drift metrics recording | **CONNECTED** | Runner writes drift scores to `drift_metrics` table (`e12f5f5`) |

### Summary

| Rating | Count | Change from March 31 |
|--------|-------|---------------------|
| CONNECTED | 13 | +10 (was 3) |
| WIRED (code exists, incomplete) | 1 | -6 (was 7) |
| RESOLVED (no longer applicable) | 1 | new |
| DISCONNECTED | 1 | -1 (was 2) |
| BROKEN | 1 | unchanged |

---

## What Changed Since March 31

| Commit | Date | Impact |
|--------|------|--------|
| `b4d4fac` | 2026-04-07 | **Supabase bridge** — db.ts rewritten, SQLite removed |
| `cd65bbd` | 2026-04-03 | **--profile + HITL** — drift gets RAG, decisions go to Supabase |
| `e12f5f5` | 2026-04-04 | **Campaigns + drift metrics** — runner is campaign-aware, writes drift_metrics |
| `17dd313` | 2026-04-06 | **Runtime memory** — Pinecone retrieval before generation |
| `b7118ce` | 2026-04-07 | **Prompt evolution** — versioning, scoring, auto-mutation |
| `260037e` (BDE) | 2026-04-07 | **Per-brand data dirs + RL trainer** — directories exist, RL reads Supabase |

---

## Overall Phase Coverage

| Phase | March 31 | April 7 | Key Change |
|-------|----------|---------|------------|
| 1. Brand Onboarding | ~20% | ~25% | Per-brand data dirs created |
| 2. Memory Formation | ~20% | ~20% | No change |
| 3. Project Activation | ~25% | ~40% | Campaign prompt propagation in runner |
| 4. Runtime Environment | ~10% | ~35% | Memory retrieval stage, campaign loading |
| 5. Generation | ~30% | ~50% | Prompt evolution + campaign prompts + brand context |
| 6. Governance & Drift | ~25% | ~55% | --profile flag, drift metrics, HITL to Supabase |
| 7. Asset Preparation | ~10% | ~10% | No change |
| 8. Insight Loop | 0% | 0% | No change |
| 9. Governed Promotion | ~5% | ~20% | RL trainer reads Supabase |
| **Overall** | **~16%** | **~28%** | |

---

## What Works End-to-End Today

1. **HUD → Supabase → os-api** — frontend and backend share Supabase as single source of truth
2. **Run pipeline** — ingest → retrieve → generate → drift → hitl → export (with campaign context)
3. **Brand_linter CLI → Pinecone** — ingest images and query brand similarity with RAG
4. **Temp-gen CLI** — generate images (Gemini) and video (Veo)
5. **HITL feedback loop** — HUD → `hitl_decisions` table → Brand_linter `rl_trainer.py`
6. **Drift monitoring** — runner records drift scores to `drift_metrics` and `drift_alerts`
7. **Prompt evolution** — rejection feedback mutates prompts across retries with lineage
8. **Supabase Realtime** — live updates on runs and run_logs

---

## Prioritized Fix List

### Tier 0 — Done

| Fix | Commit |
|-----|--------|
| Create Supabase project | Already existed |
| Create `.env` files with credentials | Already existed |
| `hitl_decisions` table | Already existed |
| Rewrite os-api db.ts → Supabase client | `b4d4fac` |
| Pass `--profile` flag in runner.ts drift stage | `cd65bbd` |
| Connect runner HITL stage to write `hitl_decisions` | `cd65bbd` |
| Record drift metrics to Supabase | `e12f5f5` |
| Campaign-aware runs (propagate campaign prompt) | `e12f5f5` |
| Sync migration files with actual DB schema | `e12f5f5` |
| Runtime memory retrieval from Pinecone | `17dd313` |
| Prompt evolution from rejection feedback | `b7118ce` |
| Create per-brand data dirs in Brand_linter | `260037e` |
| Wire RL trainer to read Supabase `hitl_decisions` | `260037e` |

### Tier 1 — Next priorities

| Fix | Effort | Impact |
|-----|--------|--------|
| Fix BDE Cohere `output_dimension` → 1536 | 5 min | Dormant — fix when BDE activated |
| `npm install` in BDE linter-api | 2 min | Unblocks BDE API |
| Ingest Cylndr E5+Cohere vectors | 2-4 hrs | Completes triple-fusion for Cylndr |
| Build HITL review UI in HUD | Large | Enables human review workflow |
| Populate Lilydale reference images | Hours | Enables Lilydale ingest |

### Tier 2 — Architecture decisions

| Decision | Options |
|----------|---------|
| BDE vs Brand_linter | Consolidate or keep separate? |
| Demo fallbacks | Keep, remove, or make configurable? |
| Gemini Embedding 2 | Replace Replicate CLIP (blocks BDE on Python 3.14) |
| HITL review UI | In HUD or separate page? |

---

## Key Files

| File | Role |
|------|------|
| `proto_front/os-api/src/runner.ts` | Central orchestrator |
| `proto_front/os-api/src/db.ts` | Supabase database operations |
| `proto_front/os-api/src/supabase.ts` | Supabase client init |
| `proto_front/os-api/src/index.ts` | Express routes (including prompt evolution) |
| `proto_front/src/api.ts` | Frontend Supabase client |
| `proto_front/src/lib/supabase.ts` | Supabase init |
| `proto_front/worker/worker.py` | Python worker entry point |
| `proto_front/worker/executors/prompt_evolver.py` | Prompt evolution executor |
| `proto_front/supabase/migrations/` | Schema migrations (001-003) |
| `Brand_linter/tools/rl_trainer.py` | RL threshold calibration (Supabase) |
| `Brand_linter/tools/image_analyzer.py` | Drift check CLI |
| `Brand_linter/tools/brand_dna_indexer.py` | Ingest CLI |
