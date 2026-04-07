# Changelog

All notable changes to this project will be documented in this file.

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
