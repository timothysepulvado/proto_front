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
| 1 | proto_front HUD → Supabase | **NOT PROVISIONED** | `.env` missing; project ID `tfbfzepaccvklpabllao` doesn't exist; migration never applied |
| 2 | proto_front os-api → SQLite | **CONNECTED** | Only working data store for the HUD |
| 3 | SQLite ↔ Supabase sync | **NOT PROVISIONED** | Supabase backend doesn't exist yet |
| 4 | os-api runner → Brand_linter ingest | **WIRED** | CLI exists, args match, venv OK (Python 3.12). No per-brand data dirs |
| 5 | os-api runner → Temp-gen generate | **WIRED** | CLI exists, args match, venv OK (Python 3.14). Would make real Gemini API calls |
| 6 | os-api runner → Brand_linter drift | **PARTIALLY WIRED** | `--profile` flag not passed by runner → Pinecone RAG never runs, pixel-only |
| 7 | Brand_linter → Pinecone | **CONNECTED** | API key present, 20 indexes, Jenni Kayne fully populated |
| 8 | BDE retriever → Pinecone | **WIRED (dim bug)** | Extractor produces 1024D Cohere for 1536D indexes |
| 9 | BDE linter-api → ml-worker | **BROKEN** | `node_modules` missing, requires local Postgres |
| 10 | proto_front → BDE | **DISCONNECTED** | Runner calls Brand_linter CLI directly, never touches BDE |
| 11 | Temp-gen output → drift check | **WIRED** | Runner chains stages, but drift is neutered (#6) |
| 12 | HITL: HUD → Supabase → BDE RL | **NOT PROVISIONED** | No Supabase project, no `hitl_decisions` table |
| 13 | Supabase Realtime → HUD | **NOT PROVISIONED** | No Supabase to subscribe to |
| 14 | Schema alignment | **DIVERGED** | proto_front and BDE schemas have zero table overlap |

### Summary

| Rating | Count |
|--------|-------|
| CONNECTED | 2 |
| WIRED (code exists, incomplete) | 4 |
| PARTIALLY WIRED | 1 |
| DISCONNECTED | 1 |
| NOT PROVISIONED | 4 |
| BROKEN | 2 |

---

## Supabase Status

The project ID `tfbfzepaccvklpabllao` referenced in proto_front config does not exist.

Active Supabase projects in the account:

| Project | ID | Status | Tables |
|---------|----|--------|--------|
| Mk2-Vr1 | nlelvebfgcxtrjuiwbms | ACTIVE | dishes, demo_runs (different app) |
| jenny kayne | mwobsatczhpxemisjhqi | ACTIVE | dishes, demo_runs (different app) |

**Neither project has Brand Studios tables.** The migration at
`supabase/migrations/001_initial_schema.sql` (clients, runs, run_logs, artifacts) was never applied.

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

**Coverage: ~20%** — Tools exist for embedding ingestion but no structured onboarding flow, no validation, no provenance.

### Phase 2: Memory Formation, Baselines, Isolation
> Protected brand foundation, long-term brand memory, RLS, versioning

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Protected brand foundation | Pinecone indexes with data | Indexes exist but no access controls |
| Long-term brand memory | Pinecone `core` and `brand-dna` tiers | Partially populated |
| RLS / governance | Supabase RLS designed but never deployed | NOT PROVISIONED |
| Versioning / branching | Not implemented | No version control on brand memory |
| Baseline approval | Not implemented | No approval flow for baselines |

**Coverage: ~15%** — Vector storage exists, governance layer is completely absent.

### Phase 3: Project / Campaign Activation
> Scoped project object with goals, audiences, destinations, branch decisions

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Project activation | HUD "Start Run" with mode selection | Minimal — mode only, no goals/audiences/destinations |
| Campaign-specific materials | Not implemented | No upload flow for project references |
| Branch / split-direction | Not implemented | No branching concept |
| Short-term project memory | Not implemented | No project-scoped memory layer |

**Coverage: ~10%** — HUD can start runs with mode selection but nothing resembling scoped project activation.

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
| Prompt evolution | Not implemented | Static prompts from runner |
| Run metadata capture | SQLite run_logs (local only) | Logs exist but not in Supabase |
| Iterative reruns | Not implemented | One-shot generation only |

**Coverage: ~30%** — Generation tools work, but no orchestration intelligence.

### Phase 6: Governance, Drift, Human Review
> Brand fit checks, drift detection, continuity testing, human gates

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Brand drift check | Brand_linter `image_analyzer.py` | **Neutered** — pixel-only (missing --profile) |
| Historical comparison | BDE triple fusion retriever | **Disconnected** from HUD runner |
| Human review gate | HITL stage in runner | Sets `needs_review` in SQLite, no UI for review |
| Governance rules | Not implemented | No automated policy checks |

**Coverage: ~15%** — Drift tools exist but aren't properly connected. HITL is a stub.

### Phase 7: Outputs, Actions, Asset Preparation
> Destination-specific formatting, packaging, delivery

| Spec Requirement | Current State | Gap |
|-----------------|---------------|-----|
| Asset preparation | Export stage (placeholder) | **Stub** — creates fake zip artifact |
| Channel-specific variants | Not implemented | No platform formatting |
| Delivery manifests | Not implemented | No delivery tracking |

**Coverage: ~5%** — Export is a placeholder.

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
| RL threshold calibration | Brand_linter `rl_trainer.py` | Exists but reads from local SQLite, disconnected |
| Governed promotion | Not implemented | No promotion flow |
| Memory layer protection | Not implemented | No contamination boundaries |

**Coverage: ~5%** — RL trainer exists conceptually but is disconnected.

### Overall Phase Coverage

| Phase | Coverage | Key Blocker |
|-------|----------|-------------|
| 1. Brand Onboarding | ~20% | No UI, no validation |
| 2. Memory Formation | ~15% | Supabase not provisioned, no RLS |
| 3. Project Activation | ~10% | No scoped project model |
| 4. Runtime Environment | ~10% | No memory retrieval |
| 5. Generation | ~30% | Tools work, no orchestration |
| 6. Governance & Drift | ~15% | Drift neutered, HITL stub |
| 7. Asset Preparation | ~5% | Export is placeholder |
| 8. Insight Loop | 0% | Not started |
| 9. Governed Promotion | ~5% | RL trainer disconnected |
| **Overall** | **~12%** | |

---

## What Works End-to-End Today

1. **Brand_linter CLI → Pinecone** — ingest images and query brand similarity
2. **Temp-gen CLI** — generate images (Gemini) and video (Veo)
3. **HUD → SQLite (local)** — renders, creates runs, streams demo logs
4. **Pinecone infrastructure** — 20 indexes provisioned, real data for 2 brands

---

## Prioritized Fix List

### Tier 0 — Foundation (must do first)

| Fix | Effort | Unblocks |
|-----|--------|----------|
| Create Supabase project for Brand Studios | 10 min | All Supabase seams |
| Apply proto_front migration | 5 min | clients/runs/run_logs/artifacts tables |
| Create `.env` files with credentials | 5 min | Frontend + backend connectivity |
| Add `hitl_decisions` table to migration | 30 min | HITL loop across repos |

### Tier 1 — Quick wiring (afternoon)

| Fix | Effort | Impact |
|-----|--------|--------|
| Pass `--profile` flag in runner.ts drift stage | 10 min | Enables RAG drift checking |
| Fix BDE Cohere `output_dimension` → 1536 | 5 min | Fixes dimension mismatch |
| `npm install` in BDE linter-api | 2 min | Unblocks BDE API |
| Create per-brand data dirs in Brand_linter | 10 min | Prevents demo fallback |
| Ingest Cylndr E5+Cohere vectors | 2-4 hrs | Completes triple-fusion |

### Tier 2 — Connect data layer (1-2 days)

| Fix | Effort | Impact |
|-----|--------|--------|
| Rewrite os-api db.ts → Supabase | 1 day | Single source of truth |
| Enable Supabase Realtime | 15 min | Live HUD updates |
| Wire BDE hitl_store to new Supabase | 2 hrs | HITL feedback loop |
| Update proto_front .mcp.json project ID | 2 min | MCP integration |

### Tier 3 — Architecture decisions

| Decision | Options |
|----------|---------|
| BDE vs Brand_linter | Consolidate or keep separate? |
| Demo fallbacks | Keep, remove, or make configurable? |
| Gemini Embedding 2 | Replace Replicate CLIP (blocks BDE on Python 3.14) |
| Unified schema | Merge proto_front + BDE schemas? |

---

## Key Files

| File | Role |
|------|------|
| `proto_front/os-api/src/runner.ts` | Central orchestrator |
| `proto_front/os-api/src/db.ts` | SQLite layer (needs Supabase bridge) |
| `proto_front/src/api.ts` | Frontend Supabase client |
| `proto_front/src/lib/supabase.ts` | Supabase init (crashes without .env) |
| `proto_front/supabase/migrations/001_initial_schema.sql` | HUD schema |
| `BDE/services/ml-worker/core/hitl_store.py` | HITL consumer |
| `BDE/services/ml-worker/core/retriever.py` | Triple fusion retriever |
| `BDE/services/ml-worker/core/feature_extractor.py` | Embedding extraction |
| `Brand_linter/local_quick_setup/tools/brand_dna_indexer.py` | Ingest CLI |
| `Brand_linter/local_quick_setup/tools/image_analyzer.py` | Drift check CLI |
