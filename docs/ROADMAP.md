# BrandStudios OS — Roadmap & State of Play

> Last updated: 2026-04-07 | Maintainer: Brandy

---

## Repos

| Repo | Location | GitHub | Branch | Latest | Purpose |
|------|----------|--------|--------|--------|---------|
| **proto_front** | ~/proto_front | timothysepulvado/proto_front | main | `cb1f2d0` | The product — HUD, runner, worker, brand-engine |
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
| HUD UI | `src/App.tsx`, `src/api.ts`, `src/lib/supabase.ts` | Working |
| os-api | `os-api/src/runner.ts`, `db.ts`, `index.ts`, `supabase.ts` | Working — Supabase backend, 6 prompt evolution routes |
| Worker | `worker/worker.py`, `executors/ingest.py`, `grading.py`, `prompt_evolver.py` | Working — polls Supabase, 4 executors |
| Brand Engine | `brand-engine/brand_engine/core/` (7 modules) + `api/server.py` + `cli/main.py` | **Added, not yet wired** |
| Migrations | `supabase/migrations/001-003` | Applied |
| Data | `hud.json` | Source of truth for UI |

**Pipeline (current):** `ingest → retrieve → generate → drift → hitl → export`
- Runner still calls Brand_linter CLI via subprocess (legacy path)
- Brand-engine SDK is committed but runner/worker rewiring is the next step

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

**Embedding upgrade:** CLIP (768D, broken on Python 3.14) + E5 (1024D) replaced by Gemini Embedding 2 (768D via MRL). Higher accuracy, natively multimodal, single API. Pinecone indexes reduced from 6 to 4 per brand.

### Migration Status

- [x] brand-engine/ SDK committed in proto_front (`cb1f2d0`)
- [x] Brand profiles for all 3 brands (cylndr, jenni_kayne, lilydale)
- [ ] Wire worker/executors to `import brand_engine.core` (replace subprocess)
- [ ] Wire os-api/runner.ts to call FastAPI sidecar (replace Brand_linter CLI spawn)
- [ ] Create Gemini Embedding 2 Pinecone indexes (4 per brand)
- [ ] Re-embed existing assets through brand-engine indexer
- [ ] Write ADR documenting consolidation decision
- [ ] Verify end-to-end pipeline through brand-engine
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

| Phase | Coverage | Key Change (April 7) |
|-------|----------|---------------------|
| 1. Brand Onboarding | ~25% | Per-brand data dirs created |
| 2. Memory Formation | ~20% | — |
| 3. Project Activation | ~40% | Campaign prompt propagation in runner |
| 4. Runtime Environment | ~35% | Memory retrieval stage added |
| 5. Generation | ~50% | Prompt evolution system built |
| 6. Governance & Drift | ~55% | --profile flag, drift metrics, HITL to Supabase |
| 7. Asset Preparation | ~10% | — |
| 8. Insight Loop | 0% | Not started |
| 9. Governed Promotion | ~20% | RL trainer reads Supabase |
| **Overall** | **~28%** | Up from 16% on March 31 |

---

## What's Next (Priority Order)

### Immediate — Brand Engine Wiring
1. Wire `worker/executors/` to `import brand_engine.core` instead of subprocess calls
2. Wire `os-api/src/runner.ts` to call brand-engine FastAPI sidecar instead of Brand_linter CLI
3. Create Gemini Embedding 2 Pinecone indexes (4 per brand × 3 brands = 12 indexes)
4. Re-embed existing assets through brand-engine indexer
5. ADR documenting the consolidation decision

### Near-term — Pipeline Completion
6. HITL review UI in the HUD (currently no UI for approve/reject)
7. Artifact writing to Supabase (generated assets → artifacts table)
8. Campaign deliverable tracking (campaign_deliverables lifecycle)
9. Alert generation logic for drift_alerts

### Medium-term — Phase Coverage
10. Baseline calculation and versioning (brand_baselines table)
11. Platform-specific asset formatting (Phase 7)
12. Insight Loop telemetry (Phase 8)
13. Governed promotion flow (Phase 9 — vector tier promotion)

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
