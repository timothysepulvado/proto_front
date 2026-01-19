# Changelog

All notable changes to this project will be documented in this file.

---

## [0.4.0] - 2026-01-18 — Phase 6.5: Generation Feedback Loop

### Added
- **Campaign Setup V2** (`CampaignSetupModal.tsx`) - Multi-step wizard with mode selection (Campaign vs Creative), configurable max retries, reference images, and guardrails (season, color palette, style notes)
- **Deliverable Builder** (`DeliverableBuilder.tsx`) - Build deliverable batches with model refs, outfit refs, pose selection, and AI model choice (Nano/Veo/Sora)
- **Rejection Categories** - Updated `HITLReviewPanel.tsx` with 10 rejection categories that map to negative prompts:
  - too_dark, too_bright, wrong_colors, off_brand, wrong_composition, cluttered, wrong_model, wrong_outfit, quality_issue, other
- **Python Workers** in `worker/workers/`:
  - `orchestrator.py` - Main campaign loop: generate → score → route → retry with short-term memory
  - `prompt_modifier.py` - Maps rejection categories to negative/positive prompt terms per AI model
  - `scoring_worker.py` - Calls BDE/Brand Linter, analyzes failure reasons from score breakdown
  - `generation_worker.py` - Interfaces with Temp-gen for Nano/Veo/Sora generation
  - `dna_updater.py` - Updates Pinecone indexes and brand profiles on final approval
- **Database Migration** (`003_campaigns_v2.sql`):
  - New enums: `deliverable_status`, `campaign_mode`, `rejection_category`
  - New tables: `campaign_deliverables`, `campaign_memory`, `rejection_categories`
  - Helper functions: `get_retry_batch()`, `get_campaign_progress()`, `mark_for_retry()`
  - Added `mode` and `max_retries` columns to `campaigns` table

### API Additions
- Campaign V2: `createCampaignV2`, `getCampaignV2`, `launchCampaignV2`
- Deliverables: `getCampaignDeliverables`, `updateDeliverableStatus`, `markDeliverableForRetry`
- Progress: `getCampaignProgress`, `getRetryBatch`, `getCampaignMemory`
- HITL V2: `createHITLDecisionV2` with rejection categories
- Real-time: `subscribeToDeliverables`

### UI Integration
- "+" button dropdown in sidebar with Campaign Setup V2, Quick Campaign, and New Client options
- CampaignSetupModal renders with full state management and log streaming

### Architecture
- **Short-term memory**: Per-campaign rejection tracking (in-memory during run)
- **Long-term memory**: Brand DNA updates via Pinecone on final approval
- **Retry loop**: Failed items get modified prompts based on rejection reasons, up to max_retries
- **Model-specific prompts**: Nano embeds negatives inline, Veo uses separate negative_prompt parameter

---

## [0.3.1] - 2026-01-18 — Phase 6: HITL/RL Integration with BDE

### Added (in BDE repo)
- **HITLStore** abstraction reads HUD's `hitl_decisions` table from Supabase
- **RL Trainer** now calibrates brand thresholds based on human approval patterns
- BDE can now automatically adjust `auto_pass_floor` based on HITL feedback

### Integration Status
- HUD → Supabase → BDE pipeline complete
- HITL decisions made in HUD are now consumed by BDE's RL trainer
- Threshold calibration loop operational (run `python tools/rl_trainer.py --brand jenni_kayne`)

### Future Work (Phase 6.5)
- Generation feedback loop to Temp-gen (not just threshold calibration)
- Structured rejection categories for prompt refinement

---

## [0.3.0] - 2026-01-18 — Phase 2: Campaign & RAG Generation

### Added
- **Campaign Creator** (`CampaignModal.tsx`) - Full campaign setup with name, prompt, deliverables (hero/lifestyle/product/video), platform targeting, and scheduling
- **HITL Review Panel** (`HITLReviewPanel.tsx`) - Review interface with CLIP/E5/Cohere/Fused score breakdown, approve/reject/request changes actions
- **Artifact Gallery** (`ArtifactGallery.tsx`) - Grid/list view with type filtering, grade badges (A+/A/B/C/D), download actions
- **Prompt Input** (`PromptInput.tsx`) - Textarea with quick prompt suggestions and brand context indicator
- **RAG Generator** (`rag_generator.py`) - Queries Pinecone for brand DNA context, augments prompts, grades outputs, auto-fix loop (max 3 attempts)
- **Campaign mode** in worker - Processes deliverables from campaign table, generates via RAG executor
- **Database migration** (`002_campaigns_and_config.sql`):
  - `campaigns` table with deliverables JSONB, platforms, status, scheduling
  - `hitl_decisions` table with grade scores and reviewer notes
  - `storage_config` and `pinecone_namespace` columns on clients
  - `grade` and `thumbnail_url` columns on artifacts

### API Additions
- Campaign CRUD: `createCampaign`, `getCampaigns`, `updateCampaign`, `deleteCampaign`, `launchCampaign`
- HITL: `createHITLDecision`, `getHITLDecisions`, `getArtifactDecisions`
- Artifacts: `getClientArtifacts`, `updateArtifactGrade`
- Storage: `updateClientStorageConfig`
- Real-time subscriptions for campaigns and artifacts

### UI Integration
- Campaign and Gallery buttons in Run Feed action bar
- Modals wired to App.tsx with full state management

---

## [0.2.0] - 2026-01-16 — Phase 1: Core Pipeline & Supabase

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
