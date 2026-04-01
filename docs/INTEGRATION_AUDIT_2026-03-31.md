# Brand Studios Integration Audit — 2026-03-31

## Purpose

This audit answers: **how far are the Brand Studios repos from working together as brandstudios.ai?**

The previous audit (2026-03-30) verified each repo builds/runs independently. This audit tests
the **integration seams** between repos and maps them against the canonical architecture spec.

---

## Repos Audited

| Repo | Role | Stack |
|------|------|-------|
| **proto_front** | HUD + os-api backend | React + Vite + Express + SQLite |
| **BDE** | Brand DNA Engine (ML worker + linter API) | Python + Node.js |
| **Brand_linter** | Standalone brand compliance CLI | Python + Node.js |
| **Temp-gen** | Image/video generation CLI | Python (Gemini, Veo, Sora) |

---

## Integration Seam Scorecard

| # | Integration Seam | Status | Evidence |
|---|-------------------|--------|----------|
| 1 | proto_front HUD → Supabase | **CONNECTED** | `.env` created, publishable key verified, 3 clients returned |
| 2 | proto_front os-api → SQLite | **CONNECTED** | Works for local dev |
| 3 | SQLite ↔ Supabase sync | **DISCONNECTED** | os-api writes SQLite, frontend reads Supabase — no bridge |
| 4 | os-api runner → Brand_linter ingest | **WIRED** | CLI exists, args match, venv OK (Python 3.12). No per-brand data dirs |
| 5 | os-api runner → Temp-gen generate | **WIRED** | CLI exists, args match, venv OK (Python 3.14). Would make real Gemini API calls |
| 6 | os-api runner → Brand_linter drift | **PARTIALLY WIRED** | `--profile` flag not passed → Pinecone RAG never runs, pixel-only |
| 7 | Brand_linter → Pinecone | **CONNECTED** | API key present, 20 indexes, Jenni Kayne fully populated |
| 8 | BDE retriever → Pinecone | **WIRED (dim bug)** | Extractor produces 1024D Cohere for 1536D indexes |
| 9 | BDE linter-api → ml-worker | **BROKEN** | `node_modules` missing, requires local Postgres |
| 10 | proto_front → BDE | **DISCONNECTED** | Runner calls Brand_linter CLI directly, never touches BDE |
| 11 | Temp-gen output → drift check | **WIRED** | Runner chains stages, but drift is neutered (#6) |
| 12 | HITL: HUD → Supabase → BDE RL | **WIRED** | `hitl_decisions` table exists (empty), BDE expects it, but os-api doesn't write to it |
| 13 | Supabase Realtime → HUD | **WIRED** | Realtime enabled on runs + run_logs, but os-api writes SQLite not Supabase |
| 14 | Schema alignment | **ADVANCED** | Supabase schema is more complete than either migration file |

### Summary

| Rating | Count |
|--------|-------|
| CONNECTED | 3 |
| WIRED (code exists, incomplete) | 7 |
| PARTIALLY WIRED | 1 |
| DISCONNECTED | 2 |
| BROKEN | 1 |

---

## Supabase Status

Project `tfbfzepaccvklpabllao` is **active** with a schema more advanced than the migration
files in the codebase. It was not visible through the Supabase MCP tool due to org/auth
mismatch, but is reachable via the Management API and REST API with the access token.

### Tables (12 total)

| Table | Rows | Notes |
|-------|------|-------|
| `clients` | 3 | Cylndr, Jenni Kayne, Lilydale — has `storage_config`, `pinecone_namespace`, `brand_slug` |
| `runs` | 1 | Cylndr failed run from Jan 17 |
| `run_logs` | 8 | Logs from that run |
| `artifacts` | 0 | Empty |
| `hitl_decisions` | 0 | Exists and ready for HITL data |
| `campaigns` | 3 | Real campaigns: Cylndr merch shoots, JK spring collection |
| `campaign_memory` | 0 | Empty — Phase 3 short-term project memory |
| `campaign_deliverables` | 0 | Empty — Phase 7 asset preparation |
| `brand_baselines` | 0 | Empty — Phase 2 memory formation |
| `drift_alerts` | 0 | Empty — Phase 6 governance |
| `drift_metrics` | 0 | Empty — Phase 6 governance |
| `rejection_categories` | 10 | Fully seeded with negative/positive prompt guidance |

### Schema vs Codebase

The Supabase schema has columns and tables not in the migration files:
- `clients` has: `storage_config` (JSONB), `pinecone_namespace`, `brand_slug`
- `campaigns`, `campaign_memory`, `campaign_deliverables` — not in any migration file
- `brand_baselines`, `drift_alerts`, `drift_metrics` — not in any migration file
- `rejection_categories` — HITL rejection taxonomy with prompt guidance
- `hitl_decisions` — the table BDE's `hitl_store.py` queries

The migration files in the repos are **behind the actual database**.

---

## Pinecone Status

20 indexes exist across two brands. Key findings:

**Jenni Kayne** — fully populated across all 3 embedding models:

| Index | Dim | Vectors |
|-------|-----|---------|
| jennikayne-brand-dna-clip768 | 768 | 106 |
| jennikayne-brand-dna-e5 | 1024 | 108 |
| jennikayne-brand-dna-cohere | 1536 | 108 |
| jennikayne-core-clip768 | 768 | 107 |
| jennikayne-core-e5-1024 | 1024 | 107 |
| jennikayne-core-cohere1536 | 1536 | 107 |
| jennikayne-campaign-* | — | ALL EMPTY |

**Cylndr** — CLIP populated, E5/Cohere partially populated:

| Index | Dim | Vectors |
|-------|-----|---------|
| cylndr-brand-dna-clip768 | 768 | 511 |
| cylndr-core-clip768 | 768 | 511 |
| cylndr-core-e5-1024 | 1024 | 511 |
| cylndr-core-cohere1536 | 1536 | 511 |
| cylndr-brand-dna-e5 | 1024 | EMPTY |
| cylndr-brand-dna-cohere | 1536 | EMPTY |
| cylndr-campaign-* | — | ALL EMPTY |

**Legacy indexes**: `jennikayne-brand-dna` (512D, 28 vectors) and `cylndr-brand-dna` (512D, empty).

**Known bug**: BDE `feature_extractor.py` requests `output_dimension: 1024` for Cohere,
but all Cohere indexes are 1536D. Queries would fail with dimension mismatch.

---

## Architecture Spec → Implementation Gap Map

Mapping the 9 phases from `BrandStudiosAI_Canonical_Architecture_Spec.docx` to current state:

### Phase 1: Brand Onboarding & Intake
> Ingest historical assets, approved work, brand rules, identity materials

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Structured onboarding intake | Brand_linter `brand_dna_indexer.py` + BDE ingestion tools | CLI-only, no UI flow |
| Source provenance tracking | Not implemented | No provenance metadata |
| Validation before baseline | Not implemented | Ingest is fire-and-forget |
| Continuity references | brand_profiles JSON per brand | Minimal — thresholds only, no strategic context |

**Coverage: ~20%** — Tools exist for embedding ingestion but no structured onboarding flow.

### Phase 2: Memory Formation, Baselines, Isolation
> Protected brand foundation, long-term brand memory, RLS, versioning

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Protected brand foundation | Pinecone indexes with data | Indexes exist but no access controls |
| Long-term brand memory | Pinecone `core` and `brand-dna` tiers | Partially populated |
| RLS / governance | Supabase RLS enabled (public policies) | Exists but permissive — needs tightening |
| Versioning / branching | `brand_baselines` table exists (empty) | Schema ready, no logic |
| Baseline approval | Not implemented | No approval flow |

**Coverage: ~20%** — Vector storage + schema exist, governance logic absent.

### Phase 3: Project / Campaign Activation
> Scoped project object with goals, audiences, destinations, branch decisions

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Project activation | `campaigns` table with 3 real entries | Schema exists with prompt, deliverables, platforms |
| Campaign-specific materials | `reference_images` column exists | Empty on all campaigns |
| Branch / split-direction | Not implemented | No branching concept |
| Short-term project memory | `campaign_memory` table exists (empty) | Schema ready, no logic |

**Coverage: ~25%** — Schema is more complete than expected. Needs execution logic.

### Phase 4: Protected Runtime Environment
> Isolated working environment with correct memory retrieval package

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Isolated working environment | os-api runner creates run context | Run object exists but no memory retrieval |
| Runtime retrieval package | Not implemented | Runner doesn't pull from Pinecone |
| Task scoping / scheduling | Not implemented | Single sequential pipeline |
| Approved tools/models | hud.json lists tools/models | Config exists, not enforced |

**Coverage: ~10%** — Runner creates runs but no memory retrieval or environment assembly.

### Phase 5: Runtime Orchestration & Generation
> Controlled generation with prompt evolution and project learning

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Image generation | Temp-gen CLI (Gemini 3 Pro) | **Works** via CLI |
| Video generation | Temp-gen CLI (Veo 3.1) | **Works** via CLI |
| Prompt evolution | `rejection_categories` has negative/positive prompts | Schema supports it, no runtime logic |
| Run metadata capture | SQLite run_logs (local only) | Logs exist but os-api writes to SQLite, not Supabase |
| Iterative reruns | Not implemented | One-shot generation only |

**Coverage: ~30%** — Generation tools work, prompt evolution schema exists.

### Phase 6: Governance, Drift, Human Review
> Brand fit checks, drift detection, continuity testing, human gates

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Brand drift check | Brand_linter `image_analyzer.py` | **Neutered** — pixel-only (missing --profile) |
| Drift tracking | `drift_alerts` + `drift_metrics` tables exist (empty) | Schema ready, no logic |
| Historical comparison | BDE triple fusion retriever | **Disconnected** from HUD runner |
| Human review gate | `hitl_decisions` table exists, HITL stage in runner | Table ready, runner writes SQLite not Supabase |
| Rejection taxonomy | `rejection_categories` fully seeded (10 categories) | Ready to use |

**Coverage: ~25%** — Schema infrastructure is solid. Execution logic missing.

### Phase 7: Outputs, Actions, Asset Preparation
> Destination-specific formatting, packaging, delivery

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Asset preparation | `campaign_deliverables` table exists (empty) | Schema ready |
| Channel-specific variants | Not implemented | No platform formatting |
| Delivery manifests | Not implemented | No delivery tracking |

**Coverage: ~10%** — Schema exists, no logic.

### Phase 8: Insight Loop & Asset Intelligence
> Performance tracking, provenance, authenticity, legal visibility

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Everything in Phase 8 | Not implemented | **Entire phase is unbuilt** |

**Coverage: 0%**

### Phase 9: Governed Promotion Back Into Memory
> Selective promotion from Insight Loop into memory layers

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| RL threshold calibration | Brand_linter `rl_trainer.py` | Exists but reads local SQLite, not Supabase |
| Governed promotion | Not implemented | No promotion flow |
| Memory layer protection | Not implemented | No contamination boundaries |

**Coverage: ~5%** — RL trainer exists but is disconnected.

### Overall Phase Coverage

| Phase | Coverage | Key Blocker |
|-------|----------|-------------|
| 1. Brand Onboarding | ~20% | No UI, no validation |
| 2. Memory Formation | ~20% | Governance logic absent |
| 3. Project Activation | ~25% | Schema ready, needs execution logic |
| 4. Runtime Environment | ~10% | No memory retrieval |
| 5. Generation | ~30% | Tools work, no orchestration |
| 6. Governance & Drift | ~25% | Drift neutered, HITL needs Supabase bridge |
| 7. Asset Preparation | ~10% | Schema only |
| 8. Insight Loop | 0% | Not started |
| 9. Governed Promotion | ~5% | RL trainer disconnected |
| **Overall** | **~16%** | |

---

## What Works End-to-End Today

1. **HUD → Supabase** — frontend can now read clients, campaigns, rejection categories
2. **Brand_linter CLI → Pinecone** — ingest images and query brand similarity
3. **Temp-gen CLI** — generate images (Gemini) and video (Veo)
4. **HUD → SQLite (local)** — renders, creates runs, streams demo logs via os-api
5. **Pinecone infrastructure** — 20 indexes provisioned, real data for 2 brands

---

## Prioritized Fix List

### Tier 0 — Done

| Fix | Status |
|-----|--------|
| ~~Create Supabase project~~ | Project already exists with 12 tables |
| ~~Create `.env` files with credentials~~ | Created for proto_front + os-api |
| ~~`hitl_decisions` table~~ | Already exists in Supabase |

### Tier 1 — Quick wiring (afternoon)

| Fix | Effort | Impact |
|-----|--------|--------|
| Pass `--profile` flag in runner.ts drift stage | 10 min | Enables RAG drift checking |
| Fix BDE Cohere `output_dimension` → 1536 | 5 min | Fixes dimension mismatch |
| `npm install` in BDE linter-api | 2 min | Unblocks BDE API |
| Create per-brand data dirs in Brand_linter | 10 min | Prevents demo fallback |
| Ingest Cylndr E5+Cohere vectors | 2-4 hrs | Completes triple-fusion |
| Sync migration files with actual DB schema | 1 hr | Codebase matches reality |

### Tier 2 — Connect data layer (1-2 days)

| Fix | Effort | Impact |
|-----|--------|--------|
| Rewrite os-api db.ts → Supabase client | 1 day | Single source of truth |
| Enable Supabase Realtime subscriptions | 15 min | Live HUD updates |
| Wire BDE hitl_store to this Supabase project | 2 hrs | HITL feedback loop |
| Connect runner HITL stage to write `hitl_decisions` | 2 hrs | Close the feedback loop |

### Tier 3 — Architecture decisions

| Decision | Options |
|----------|---------|
| BDE vs Brand_linter | Consolidate or keep separate? |
| Demo fallbacks | Keep, remove, or make configurable? |
| Gemini Embedding 2 | Replace Replicate CLIP (blocks BDE on Python 3.14) |

---

## Key Files

| File | Role |
|------|------|
| `proto_front/os-api/src/runner.ts` | Central orchestrator |
| `proto_front/os-api/src/db.ts` | SQLite layer (needs Supabase bridge) |
| `proto_front/src/api.ts` | Frontend Supabase client |
| `proto_front/src/lib/supabase.ts` | Supabase init |
| `proto_front/supabase/migrations/001_initial_schema.sql` | HUD schema (behind actual DB) |
| `BDE/services/ml-worker/core/hitl_store.py` | HITL consumer |
| `BDE/services/ml-worker/core/retriever.py` | Triple fusion retriever |
| `BDE/services/ml-worker/core/feature_extractor.py` | Embedding extraction (Cohere dim bug) |
| `Brand_linter/local_quick_setup/tools/brand_dna_indexer.py` | Ingest CLI |
| `Brand_linter/local_quick_setup/tools/image_analyzer.py` | Drift check CLI |
