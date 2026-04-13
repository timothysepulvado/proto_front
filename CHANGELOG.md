# Changelog

All notable changes to this project will be documented in this file.

## [0.9.0] - 2026-04-11

### Added
- **Cloudinary transform/CDN layer** — optional dual-write integration that uploads artifacts to Cloudinary alongside Supabase Storage. 10 platform presets: `ig_feed`, `ig_story`, `fb_feed`, `fb_story`, `x_post`, `x_header`, `linkedin_post`, `pinterest_pin`, `tiktok_video`, `youtube_thumb`.
- **`os-api/src/cloudinary.ts`** — Cloudinary client with `uploadToCloudinary()` and `getTransformUrl()`. Stores `cloudinaryPublicId` in artifact metadata JSONB.
- **`GET /api/artifacts/:artifactId/platforms`** — returns platform-specific CDN URLs with auto-optimization, responsive sizing, format conversion. Query param: `?platforms=ig_feed,fb_feed`.
- **`getArtifactPlatformUrls()`** in `src/api.ts` — frontend helper for platform variant URLs. Data layer only (no UI component yet).
- Graceful degradation: no `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` env vars = zero Cloudinary calls, pipeline identical to before.

### Changed
- `os-api/src/storage.ts` — dual-write: uploads to both Supabase Storage and Cloudinary when configured.
- `os-api/src/runner.ts` — artifact creation pipeline calls Cloudinary upload on success.
- `os-api/src/types.ts` — Artifact metadata can include `cloudinaryPublicId`.
- `package.json` — added `cloudinary` dependency.

## [0.8.0] - 2026-04-11

### Added
- **Baseline calculation & versioning** — brand baselines now computed and stored as versioned snapshots in `brand_baselines` table. Drift scoring measured against real baseline data.
- **`BaselinePanel.tsx`** — new component in Brand Drift pillar showing current baseline version, last computed date, and key metrics. Renders alongside `DriftAlertPanel` when a client is selected.
- **Baseline API routes** — baseline CRUD and computation endpoints wired through os-api.
- **Brand-engine baseline computation** — sidecar computes baseline embeddings from indexed brand assets.

### Changed
- `src/App.tsx` — Brand Drift pillar now renders `BaselinePanel` + `DriftAlertPanel` together when a client is active.

## [0.7.0] - 2026-04-10

### Added
- **Drift alert surfacing + acknowledgment** — full read/display/ack pipeline from Supabase `drift_alerts` through API routes to live UI. Brand Drift pillar tab now renders real content instead of a generic placeholder.
- **`DriftAlertPanel.tsx`** — new component with severity badges (critical/error/warn), unacknowledged-first sorting, inline resolution notes, acknowledge button with spinner, realtime subscription via `subscribeToDriftAlerts()`. Empty state shows "Brand alignment healthy" with shield icon.
- **4 new drift API routes** — `GET /api/clients/:clientId/drift-alerts`, `GET /api/runs/:runId/drift-alerts`, `GET /api/runs/:runId/drift-metrics`, `POST /api/drift-alerts/:alertId/acknowledge`.
- **4 new DB query functions** — `getDriftMetricsByRun()`, `getDriftAlertsByClient()`, `getDriftAlertsByRun()`, `acknowledgeDriftAlert()` with proper Db row types and mappers.
- **Frontend drift operations** — `getDriftAlerts()`, `getDriftMetrics()`, `acknowledgeDriftAlert()`, `subscribeToDriftAlerts()` in `src/api.ts` with full `DriftAlert`/`DriftMetric` types and Db row mappers.

### Changed
- `os-api/src/types.ts` — `DriftAlert` type extended with `acknowledgedAt` and `resolutionNotes` fields (matching existing DB columns from migration 002).
- `os-api/src/db.ts` — extracted `DbDriftMetric`/`DbDriftAlert` interfaces and `mapDbDriftMetricToDriftMetric`/`mapDbDriftAlertToDriftAlert` mappers. Refactored `addDriftMetric()` and `addDriftAlert()` to use shared mappers instead of inline object literals.
- `src/App.tsx` — Brand Drift pillar tab now renders `DriftAlertPanel` when a client is selected.

## [0.6.0] - 2026-04-10

### Added
- **Campaign deliverable tracking** — full per-asset lifecycle wired through generation + HITL pipeline. Status machine: `pending → generating → reviewing → approved/rejected → regenerating`.
- **`DeliverableTracker.tsx`** — new component with live status badges, retry counts, and Supabase Realtime subscription. Renders in Creative Studio pillar when a campaign run is active.
- **8 new API routes** — campaign CRUD (`GET/POST /api/clients/:clientId/campaigns`, `GET /api/campaigns/:campaignId`), deliverable CRUD + lifecycle (`GET/POST /api/campaigns/:campaignId/deliverables`, `GET /api/deliverables/:deliverableId`, `PATCH /api/deliverables/:deliverableId/status`, `POST /api/deliverables/:deliverableId/regenerate`).
- **`executeDeliverableGeneration()`** in runner.ts — per-deliverable prompt building from deliverable → campaign fallback, artifact linking via `deliverable_id`, status transitions with optimistic lock.
- **HITL cascade** — approve route batch-updates all `reviewing` deliverables to `approved`; reject route targets specific deliverable or all, with rejection reason stored.
- **Migration 005** (`005_deliverable_tracking.sql`) — `artifacts.deliverable_id` FK, status index on `campaign_deliverables`, `updated_at` trigger, extended `deliverable_status` enum with `reviewing/rejected/regenerating`.
- **Realtime subscription** — `subscribeToCampaignDeliverables()` in frontend api.ts for live deliverable status updates.
- **ReviewPanel deliverable context** — shows deliverable description + status badge above artifact cards when artifact has `deliverableId`.

### Changed
- `os-api/src/types.ts` — added `DeliverableStatus` type, `VALID_DELIVERABLE_TRANSITIONS` map, `Campaign` and `CampaignDeliverable` interfaces, `Artifact.deliverableId`, `RunCreatePayload.deliverableIds`.
- `os-api/src/db.ts` — 8 new functions, `getCampaign()` now returns typed `Campaign` (was `Record<string, unknown>`), `DbArtifact`/`addArtifact()` include `deliverable_id`. DB row types aligned with live Supabase schema.
- `os-api/src/runner.ts` — image and video stages branch on `run.campaignId` + pending deliverables. Video stage now supports campaign prompt (was hardcoded).
- `src/api.ts` — `Run.campaignId` wired through `DbRun` mapper, `Artifact.deliverableId` wired, new types + query functions.
- `src/App.tsx` — imports and renders `DeliverableTracker` in Creative Studio pillar.

## [0.5.3] - 2026-04-09

### Added
- **Supabase Storage integration** — generated images/videos uploaded to `artifacts` bucket, public URLs stored in artifacts table. Storage path convention: `{client_id}/{run_id}/{artifact_id}.{ext}` for cross-DB traceability.
- **`os-api/src/storage.ts`** — upload utility with MIME detection, file size tracking, graceful fallback to local path on upload failure.
- **`createArtifactWithUpload()`** helper in runner.ts — DRY wrapper across all 5 artifact creation sites. Records model, prompt, and stage metadata.
- **Artifact preview in ReviewPanel** — inline `<img>` / `<video>` rendering when artifact path is a URL, plus prompt display from metadata.
- **Migration 004** (`004_artifact_storage.sql`) — new columns on artifacts table: `client_id`, `campaign_id`, `stage`, `storage_path`, `metadata`. Storage bucket with RLS policies. Backfill of client_id from runs. Realtime enabled on artifacts.
- Worker `_upload_to_storage()` method — Python-side Supabase Storage upload with same path convention.
- Creative executor now returns `stage` and `metadata` (model, prompt) on artifact dicts.

### Changed
- `os-api/src/types.ts` — Artifact interface expanded with `clientId`, `campaignId`, `storagePath`, `stage`, `metadata`.
- `os-api/src/db.ts` — DbArtifact type, mapper, and `addArtifact()` write all new columns.
- `src/api.ts` — frontend Artifact + DbArtifact types synced with new schema.
- `worker/worker.py` — `_add_artifact()` accepts `client_id`/`campaign_id`, uploads to Storage before insert.

## [0.5.1] - 2026-04-08

### Added
- **brand-engine wiring** — worker executors import `brand_engine.core` directly (no subprocess). runner.ts calls FastAPI sidecar via HTTP.
- **Gemini Embedding 2** (`gemini-embedding-2-preview`) — replaces CLIP+E5. Natively multimodal, 768D via MRL.
- **Cohere v4 via AWS Bedrock** (`us.cohere.embed-v4:0`, 1536D) — replaces direct Cohere API.
- **`/retrieve` endpoint** on brand-engine sidecar — text-query-only dual-fusion retrieval for runner.ts.
- **Pinecone indexes** — 3 Gemini 768D indexes (brand-dna tier, all brands) + 1 Cohere for lilydale.
- `callBrandEngine<T>()` typed helper in runner.ts with abort timeout.
- `.env` files for brand-engine, worker, os-api with all API keys configured.
- `brand-engine/.venv` (Python 3.13) with all dependencies installed.
- ADR-002: BDE + Brand_linter consolidation decision record.

### Changed
- `worker/executors/ingest.py` — rewrote from subprocess Brand_linter to BrandIndexer import.
- `worker/executors/grading.py` — rewrote from subprocess Brand_linter to BrandGrader import.
- `worker/config.py` — adds brand-engine to sys.path, brand asset paths.
- `os-api/src/runner.ts` — ingest/retrieve/drift stages call brand-engine sidecar, not Brand_linter.
- `brand-engine/core/embeddings.py` — supports both Bedrock and direct Cohere API, accepts GEMINI_API_KEY or GOOGLE_GENAI_API_KEY.
- JK brand profile index names: `jenni_kayne-*` → `jennikayne-*` (matches existing Pinecone indexes).
- Caption model: `gemini-2.0-flash` → `gemini-2.5-flash`.

### Removed
- 8 superseded Pinecone indexes (E5 1024D ×6, legacy 512D ×2). Capacity: 16/20.

## [0.5.0] - 2026-04-07

### Added
- **Prompt evolution system** — versioned templates, per-use scoring, auto-evolution from rejection feedback, lineage tracking (`prompt_templates`, `prompt_scores`, `prompt_evolution_log` tables + 6 API routes)
- **Runtime memory retrieval stage** — Pinecone query before generation assembles brand context
- **Campaign-aware runs** — campaign prompt propagation to generate and drift stages
- **Drift metrics recording** — runner writes to Supabase `drift_metrics` and `drift_alerts` tables
- **Schema sync migration** (002) aligning codebase with live Supabase (hitl_decisions, rejection_categories, drift tables, campaigns)

### Changed
- **os-api db.ts rewritten from SQLite to Supabase client** — single source of truth
- Drift stage now passes `--profile` flag enabling RAG similarity (not just pixel analysis)
- HITL decisions now written to Supabase `hitl_decisions` table (was SQLite)
- Run mode `full` pipeline expanded: `ingest → retrieve → generate → drift → hitl → export`

## [0.4.0] - 2026-04-02

### Added
- **Cross-repo integration audit** (`docs/INTEGRATION_AUDIT_2026-03-31.md`) mapping 14 seams
- **Technical requirements for client implementation** (`docs/TECH_REQUIREMENTS_CLIENT_IMPLEMENTATION.md`)
- **DOCS_INDEX.md** — documentation index with cross-repo pointers

### Changed
- Reclassified BDE Cohere dimension mismatch as dormant (Brand_linter is active path)

## [0.3.0] - 2026-01-17

### Added
- **Supabase integration** — initial schema migration with clients, runs, run_logs, artifacts tables
- **Supabase MCP server configuration** (`.mcp.json`)
- **Python worker** (`worker/`) for headless run execution via Supabase polling
- Worker executors: ingest, creative, grading, prompt evolution

## [0.2.0] - 2026-01-16

### Added
- **os-api backend** - Express server with SQLite storage for run orchestration
- **SSE log streaming** - Real-time logs from API to HUD Run Feed
- **Four Pillars UI** - Brand Memory, Creative Studio, Brand Drift, Insight Loop tabs
- **Run menu** - Dropdown with Full Pipeline, Ingest, Images, Video, Drift, Export modes
- **Cancel button** - Stop active runs mid-execution
- **Review/Export buttons** - HITL approval and artifact export
- **Demo mode fallback** - Simulated logs when external tools unavailable
- **Concurrent dev scripts** - `npm run dev:all` runs HUD + API together

### Changed
- Renamed UI labels to BrandStudios vocabulary (Brand Memory, Signals, Sync, Agents, etc.)
- Run Feed now shows stage tags `[ingest]`, `[generate]`, etc.
- Scrollable log area with auto-scroll on new entries

### Wired
- Temp-gen CLI for image generation (`nano generate`)
- Temp-gen CLI for video generation (`veo generate`)
- Brand_linter for asset indexing (`brand_dna_indexer.py`)
- Brand_linter for drift analysis (`image_analyzer.py`)

## [0.1.3] - 2026-01-16

- Tightened HUD layout spacing and reduced client detail stack width/height for a lighter overlay.
- Shifted top status bar into a smaller floating cluster.
- Added client detail collapse behavior tied to the active client button.

## [0.1.4] - 2026-01-16

- Start HUD with no client detail open by default; requires explicit client selection.

## [0.1.5] - 2026-01-16

- Scoped scanline/noise/vignette effects to HUD panels only and removed background overlays.

## [0.1.2] - 2026-01-15

- Replaced external background and grain URLs with local assets.
- Pruned unused scaffold files and refreshed the file tree.

## [0.1.1] - 2026-01-15

- Switched the UI to the new CRT/HUD layout with a draggable Pancake Core toggle.
- Added Tailwind v4 + lucide-react for the updated component styling.
- Refined intake modal, telemetry, and agent stream to use `hud.json` data.

## [0.1.0] - 2026-01-15

- Scaffolded a Vite React + TypeScript repo in `HUD/`.
- Implemented the HUD UI in `src/App.tsx` and `src/App.css`.
- Preserved the static preview at `docs/static-preview.html`.
- Added Node/npm policy files (`.nvmrc`, `.npmrc`) and updated `package.json`.
