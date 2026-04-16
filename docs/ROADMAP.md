# BrandStudios OS — Roadmap & State of Play

> Last updated: 2026-04-12 | Maintainer: Brandy

---

## Repos

| Repo | Location | GitHub | Branch | Latest | Purpose |
|------|----------|--------|--------|--------|---------|
| **proto_front** | ~/proto_front | timothysepulvado/proto_front | main | `c5bfe4c` | The product — HUD, runner, worker, brand-engine |
| **Brand_linter** | ~/Brand_linter/local_quick_setup | timothysepulvado/BDE | phase-3 | `74eebbd` | Legacy brand compliance CLI (being superseded by brand-engine) |
| **BDE** | ~/BDE | timothysepulvado/BDE | main | `cbdc8b7` | Sidelined ML worker architecture (OOP absorbed into brand-engine) |
| **Temp-gen** | ~/Temp-gen | timothysepulvado/Temp-gen | main | `1a19a4d` | AI image/video generation (Gemini 3 Pro, Veo 3.1) + FastAPI sidecar :8200 |

---

## proto_front — What's In It

**Frontend:** React 19 + TypeScript + Vite + Tailwind v4
**Backend:** Express os-api → Supabase (SQLite removed)
**Worker:** Python worker polling Supabase for runs
**Brand Engine:** New consolidated SDK (Gemini Embed 2 + Cohere v4 dual fusion)

| Layer | Key Files | Status |
|-------|-----------|--------|
| HUD UI | `src/App.tsx`, `src/api.ts`, `src/components/ReviewPanel.tsx`, `DeliverableTracker.tsx`, `DriftAlertPanel.tsx`, `BaselinePanel.tsx`, `src/lib/supabase.ts` | Working — 5 pillar tabs (4/5 have live UI content), scrollable layout |
| os-api | `os-api/src/runner.ts`, `db.ts`, `index.ts`, `types.ts`, `cloudinary.ts`, `supabase.ts` | Working — calls brand-engine sidecar via HTTP, campaign deliverable pipeline, optional Cloudinary CDN |
| Worker | `worker/worker.py`, `executors/ingest.py`, `grading.py`, `prompt_evolver.py` | Working — imports brand_engine.core directly |
| Brand Engine | `brand-engine/brand_engine/core/` (7 modules) + `api/server.py` + `cli/main.py` | **Wired — E2E verified** |
| Migrations | `supabase/migrations/001-005` | Applied |
| Data | `hud.json` | Source of truth for UI |

**Pipeline (current):** `ingest → retrieve → generate → drift → hitl → export`
- Runner calls brand-engine FastAPI sidecar at `:8100` (ingest, retrieve, drift stages)
- Worker executors import `brand_engine.core` directly (Python-to-Python, no subprocess)
- Generate stages still call Temp-gen CLI via subprocess (unchanged)

### Pillar Definitions

| Pillar | Scope | Current UI | Status |
|--------|-------|-----------|--------|
| **Brand Memory** | Ingest, index, embed brand assets | Run controls (placeholder) | Basic |
| **Creative Studio** | Generate + track deliverables + prompt evolution (INTERNAL creative loop) | DeliverableTracker | Live |
| **Brand Drift** | Compliance scoring, drift metrics, baselines | BaselinePanel + DriftAlertPanel | Live |
| **Review Gate** | Human-in-the-loop review and approval | ReviewPanel (pending runs list) | Live |
| **Insight Loop** | EXTERNAL intelligence — asset performance in the wild, platform engagement, ROI | (empty) | Not started |

**Creative Studio** owns the full creative cycle: generate → track deliverables → see prompt performance → evolve prompts → generate better. This is the internal feedback loop.

**Insight Loop** is the external intelligence layer: what happens to assets after they leave the system. Platform engagement data, brand sentiment, aggregate trends. Requires external data source integrations (Phase 8).

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

Production-ready unified CLI + FastAPI sidecar (:8200). Two active models:
- `python main.py nano generate` → Gemini 3 Pro Image (`gemini-3-pro-image-preview`)
- `python main.py veo generate` → Veo 3.1 (`veo-3.1-generate-001`)
- `python -m api.server` → Sidecar on :8200 (image sync, video async+poll, cost estimation, batch)
- Sora 2 — discontinued April 2026. CLI stub archived.

Runner calls sidecar via HTTP (replaced subprocess). Demo fallback if sidecar down.

---

## Architecture Coverage (vs Canonical 9-Phase Spec)

| Phase | Coverage | Key Change (April 12) |
|-------|----------|---------------------|
| 1. Brand Onboarding | ~30% | Per-brand data dirs + brand profiles wired |
| 2. Memory Formation | ~35% | Gemini Embed 2 + Cohere v4 pipeline verified E2E |
| 3. Project Activation | ~55% | Campaign deliverable tracking — per-asset lifecycle wired |
| 4. Runtime Environment | ~40% | Memory retrieval via brand-engine /retrieve |
| 5. Generation | ~70% | Deliverable-aware generation (per-deliverable prompt, artifact linking) |
| 6. Governance & Drift | **~85%** | **Drift alerts (#9) + baseline versioning (#10) + HITL cascade** |
| 7. Asset Preparation | **~30%** | **Cloudinary CDN layer (#11) — 10 platform presets, dual-write** |
| 8. Insight Loop | 0% | Not started (external asset tracking — requires data source integrations) |
| 9. Governed Promotion | ~20% | RL trainer reads Supabase |
| **Overall** | **~41%** | Up from ~36% (v0.7.0) |

---

## What's Next (Priority Order)

### Done — Brand Engine + HITL (Tasks 1-6)
1. ~~Wire worker/executors~~ ✅ (`ced83f3`)
2. ~~Wire runner.ts to sidecar~~ ✅ (`ced83f3`)
3. ~~Create Gemini Embed 2 Pinecone indexes~~ ✅ (brand-dna tier)
4. ~~Re-embed existing JK assets~~ ✅ (`0fedc40`, 23 images)
5. ~~ADR~~ ✅ (`~/agent-vault/adr/002`)
6. ~~HITL Review UI~~ ✅ (`22f350a` + `f78945b` + `65fa72f`) — ReviewPanel, Review Gate pillar, nav badge, 3 entry points

### Done — Artifact Storage + Deliverables (Tasks 7-8)
7. ~~Artifact writing to Supabase~~ ✅ (`c10eaec`) — Supabase Storage bucket + upload pipeline, migration 004
8. ~~Campaign deliverable tracking~~ ✅ (`3ddafbb`) — Full per-asset lifecycle, DeliverableTracker component, 8 API routes, migration 005

### Done — Drift, Baselines, CDN (Tasks 9-11)
9. ~~Drift alert surfacing + acknowledgment~~ ✅ (`a859c68`) — DriftAlertPanel, severity badges, ack flow, 4 API routes, realtime
10. ~~Baseline calculation & versioning~~ ✅ (`2aac4e4`) — BaselinePanel, baseline snapshots, baseline-aware drift scoring
11. ~~Cloudinary transform/CDN layer~~ ✅ (`c5bfe4c`) — Optional dual-write, 10 platform presets, graceful degradation, `GET /api/artifacts/:id/platforms`

### Done — Creative Loop (Task 12)
12. ~~Prompt Evolution UI in Creative Studio~~ ✅ (`13824b0`) — PromptEvolutionPanel with active prompt card, score indicator, manual editor, version history (lazy scores), evolution lineage log, realtime subscription. `createPrompt()` in api.ts. Wired alongside DeliverableTracker in Creative Studio pillar.

### Next — Runner ↔ Prompt Wiring
13. Wire prompt_templates into runner + Temp-gen pipeline — runner reads active prompt via `getActivePrompt()` instead of hardcoded fallback, passes promptText to Temp-gen generation, scores fed back after HITL review to close the evolution loop. Connects Creative Studio UI (Task #12) to actual generation.

### Medium-term — Phase Coverage
14. Platform variant picker component (Cloudinary UI for Task #11)
15. Insight Loop telemetry (Phase 8 — external asset tracking, platform engagement)
16. Governed promotion flow (Phase 9 — vector tier promotion)
17. End-to-end pipeline verification (full run through brand-engine)

---

## Docs — All Synced

| Doc | Location | Status |
|-----|----------|--------|
| CHANGELOG | proto_front, Brand_linter, Temp-gen | Current through v1.0.0 (2026-04-12) |
| README | All 3 repos | Updated — current architecture |
| Integration Audit | proto_front `docs/INTEGRATION_AUDIT_2026-04-07.md` | 18 seams, 28% coverage |
| Tech Requirements | proto_front `docs/TECH_REQUIREMENTS` | 13 items marked RESOLVED |
| Vault projects.md | ~/agent-vault | All 4 repos listed |
| Vault MISSION.md | ~/agent-vault/domains/brandstudios | Rewritten with all repos |
| This roadmap | ~/agent-vault/domains/brandstudios/ROADMAP.md | You are here |

---

## Active Handoffs (2026-04-16, append)

### Drift MV — Escalation System + Shot 27 Resolution
- **Handoff:** `~/proto_front/.claude/handoffs/2026-04-16-escalation-system-shot-27.md`
- **Context:** Drift MV Shot 27 hit a Veo model limitation (atmospheric creep from fire/smoke on extended aerials) that L1/L2 prompt fixes cannot resolve. Surfaces a product gap: Shot Escalation Ladder doctrine exists in Temp-gen docs but there's zero product instrumentation.
- **Staged execution:**
  - Phase A — Jackie motion QA on 5 v3/v4-resolved shots (05, 07, 15, 18, 20)
  - Phase B — Shot 27 L3 resolution (Option B redesign or Option C replace)
  - Phase C1 — Supabase migration 007 (`known_limitations` + `asset_escalations` tables + 7-rule seed)
  - Phase C2 — Runner wall-detection logic + 7 new API endpoints
  - Phase C3 — Review Gate UI (EscalationPanel, RedesignWorkflow, badges)
- **Gates:** Drift MV Phase 3 assembly is blocked until Phase A + B + C1 are complete
- **Priority relative to tasks 14-17 above:** Decision pending — the client-facing urgency of the escalation system may bump it ahead of the Platform variant picker
