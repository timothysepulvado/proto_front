# Changelog

All notable changes to this project will be documented in this file.

## [0.1.6] - 2026-01-16

- Shifted HUD copy to BrandStudios vocabulary and added four-pillar client scaffolding.
- Added run controls, stage progress, HITL review handling, and run metadata display.
- Introduced a local os-api service with SSE log streaming and CLI orchestration for Temp-gen and Brand linter.
- Added Vite proxying and dev scripts to run HUD and os-api together.

## [0.1.7] - 2026-01-16

- Added a cancel action for in-progress runs.
- Improved client header readability with a blurred status card.
- Added scrollable client detail panel and log wrapping for long lines.

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
