# Changelog

All notable changes to this project will be documented in this file.

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
