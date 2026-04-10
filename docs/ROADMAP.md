# BrandStudios OS — Roadmap & State of Play

> Last updated: 2026-04-10 | Maintainer: Brandy

---

## Repos

| Repo | Location | GitHub | Branch | Latest | Purpose |
|------|----------|--------|--------|--------|---------|
| **proto_front** | ~/proto_front | timothysepulvado/proto_front | main | `78d4edf` | The product — HUD, runner, worker, brand-engine |
| **Brand_linter** | ~/Brand_linter/local_quick_setup | timothysepulvado/BDE | phase-3 | `74eebbd` | Legacy brand compliance CLI (being superseded by brand-engine) |
| **BDE** | ~/BDE | timothysepulvado/BDE | main | `cbdc8b7` | Sidelined ML worker architecture (OOP absorbed into brand-engine) |
| **Temp-gen** | ~/Temp-gen | timothysepulvado/Temp-gen | main | `921180a` | AI image/video generation (Gemini 3 Pro, Veo 3.1, Sora 2) |

---

## proto_front — What's In It

**Frontend:** React 19 + TypeScript + Vite + Tailwind v4
**Backend:** Express os-api → Supabase (SQLite removed)
**Worker:** Python worker polling Supabase for runs
**Brand Engine:** New consolidated SDK (Gemini Embed 2 + Cohere v4 dual fusion)

| Layer | Key Files | Status |
|-------|-----------|--------|
| HUD UI | `src/App.tsx`, `src/api.ts`, `src/components/ReviewPanel.tsx`, `DriftAlertPanel.tsx`, `DeliverableTracker.tsx`, `src/lib/supabase.ts` | Working — 5 pillar tabs, Review Gate + Brand Drift + Creative Studio live |
| os-api | `os-api/src/runner.ts`, `db.ts`, `index.ts`, `supabase.ts` | Working — calls brand-engine sidecar via HTTP |
| Worker | `worker/worker.py`, `executors/ingest.py`, `grading.py`, `prompt_evolver.py` | Working — imports brand_engine.core directly |
| Brand Engine | `brand-engine/brand_engine/core/` (7 modules) + `api/server.py` + `cli/main.py` | **Wired — E2E verified** |
| Migrations | `supabase/migrations/001-005` | Applied |
| Data | `hud.json` | Source of truth for UI |

**Pipeline (current):** `ingest → retrieve → generate → drift → hitl → export`
- Runner calls brand-engine FastAPI sidecar at `:8100` (ingest, retrieve, drift stages)
- Worker executors import `brand_engine.core` directly (Python-to-Python, no subprocess)
- Generate stages still call Temp-gen CLI via subprocess (unchanged)

**Supabase tables (15):** clients, runs, run_logs, artifacts, hitl_decisions, rejection_categories, campaigns, campaign_deliverables, campaign_memory, drift_metrics, drift_alerts, brand_baselines, prompt_templates, prompt_scores, prompt_evolution_log

---

## Brand Engine Consolidation

### The Decision (Jackie + /ultraplan, 2026-04-07)

BDE's OOP class hierarchy + Brand_linter's production features → merged into `brand-engine/` inside proto_front.

| What | From | Into |
|------|------|------|
| FeatureExtractor, Retriever, Fusion classes | BDE core/ | brand-engine core/ |
| Cohere multi-crop, unified ingest, batch tools | Brand_linter tools/ | brand-engine core/ |
| RL threshold trainer (Supabase) | Brand_linter rl_trainer.py | brand-engine core/trainer.py |
| CLIP + E5 embeddings | Both (removed) | Replaced by Gemini Embedding 2 (768D MRL) |
| Cohere v4 (1536D) | Both (kept) | brand-engine core/embeddings.py |
| PostgreSQL job queue | BDE (dropped) | Supabase runs table covers this |
| Express linter-api | BDE (dropped) | FastAPI sidecar in brand-engine |

**Embedding upgrade:** CLIP (768D, broken on Python 3.14) + E5 (1024D) replaced by Gemini Embedding 2 (`gemini-embedding-2-preview`, 768D via MRL). Caption model: `gemini-2.5-flash`. Cohere v4 via AWS Bedrock (`us.cohere.embed-v4:0`, 1536D). Pinecone indexes reduced from 6 to 4 per brand. Old E5 and 512D indexes deleted (16/20 capacity used).

### Migration Status

- [x] brand-engine/ SDK committed in proto_front (`cb1f2d0`)
- [x] Brand profiles for all 3 brands (cylndr, jenni_kayne, lilydale)
- [x] Wire worker/executors to `import brand_engine.core` (replace subprocess)
- [x] Wire os-api/runner.ts to call FastAPI sidecar (replace Brand_linter CLI spawn)
- [x] Create Gemini Embedding 2 Pinecone indexes (brand-dna tier, 3 brands)
- [x] Write ADR documenting consolidation decision (`~/agent-vault/adr/002`)
- [x] Verify embedding pipeline E2E (Gemini Embed 2 + Cohere v4 Bedrock → Pinecone)
- [x] Re-embed existing assets through brand-engine indexer (23 JK images → Gemini 768D + Cohere 1536D → Pinecone)
- [ ] Verify end-to-end pipeline through brand-engine (full run)
- [ ] Deprecate Brand_linter subprocess calls in runner
- [ ] Archive BDE main and Brand_linter phase-3 branches

---

## Temp-gen

Production-ready unified CLI. Three models operational:
- `python main.py nano generate` → Gemini 3 Pro Image
- `python main.py veo generate` → Veo 3.1 (Vertex AI)
- `python main.py sora generate` → Sora 2 / 2 Pro

Called by proto_front runner for the generate stage. Integration seam verified.

---

## Architecture Coverage (vs Canonical 9-Phase Spec)

| Phase | Coverage | Key Change (April 10) |
|-------|----------|---------------------|
| 1. Brand Onboarding | ~30% | Per-brand data dirs + brand profiles wired |
| 2. Memory Formation | ~35% | Gemini Embed 2 + Cohere v4 pipeline verified E2E |
| 3. Project Activation | ~45% | Campaign deliverable lifecycle wired E2E |
| 4. Runtime Environment | ~40% | Memory retrieval via brand-engine /retrieve |
| 5. Generation | ~55% | Deliverable-level generation + artifact storage pipeline |
| 6. Governance & Drift | ~80% | Drift alert surfacing + ack UI, HITL Review Gate, deliverable tracking |
| 7. Asset Preparation | ~15% | Supabase Storage artifact pipeline |
| 8. Insight Loop | 0% | Not started |
| 9. Governed Promotion | ~20% | RL trainer reads Supabase |
| **Overall** | **~36%** | Up from 33% (v0.6.0) |

---

## What's Next (Priority Order)

### Immediate — Brand Engine Completion
1. ~~Wire worker/executors~~ ✅
2. ~~Wire runner.ts to sidecar~~ ✅
3. ~~Create Gemini Embed 2 Pinecone indexes~~ ✅ (brand-dna tier)
4. ~~Re-embed existing JK assets (23 images) through brand-engine indexer~~ ✅
5. ~~ADR~~ ✅ (`~/agent-vault/adr/002`)

### Done — HITL
6. ~~HITL Review UI~~ ✅ (`22f350a` + `f78945b` + `65fa72f`) — ReviewPanel component, Review Gate pillar tab, nav notification badge, 3 entry points

### Done — Pipeline Completion
7. ~~Artifact writing to Supabase~~ ✅ (`c10eaec`) — Supabase Storage pipeline, migration 004, public URLs
8. ~~Campaign deliverable tracking~~ ✅ (`3ddafbb`) — full per-asset lifecycle, DeliverableTracker component, 8 API routes
9. ~~Drift alert surfacing + acknowledgment~~ ✅ — DriftAlertPanel, 4 drift API routes, realtime subscription, severity badges + ack flow

### Next — Drift & Baselines
10. Baseline calculation and versioning (brand_baselines table)
11. End-to-end pipeline verification (full run through brand-engine)

### Medium-term — Phase Coverage
12. Platform-specific asset formatting (Phase 7)
13. Insight Loop telemetry (Phase 8)
14. Governed promotion flow (Phase 9 — vector tier promotion)

---

## Docs — All Synced

| Doc | Location | Status |
|-----|----------|--------|
| CHANGELOG | proto_front, Brand_linter, Temp-gen | Backfilled through 2026-04-07 |
| README | All 3 repos | Updated — current architecture |
| Integration Audit | proto_front `docs/INTEGRATION_AUDIT_2026-04-07.md` | 18 seams, 28% coverage |
| Tech Requirements | proto_front `docs/TECH_REQUIREMENTS` | 13 items marked RESOLVED |
| Vault projects.md | ~/agent-vault | All 4 repos listed |
| Vault MISSION.md | ~/agent-vault/domains/brandstudios | Rewritten with all repos |
| This roadmap | ~/agent-vault/domains/brandstudios/ROADMAP.md | You are here |
