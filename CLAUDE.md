@AGENTS.md

## Domain: brandstudios
This project is in the **brandstudios** domain. On session start, also read:
- `~/agent-vault/domains/brandstudios/MISSION.md` — domain mission, stack, phase
- Tag all daily log entries with `[brandstudios]`

# BrandStudios OS HUD — Project Context

## What This Is
The main product HUD for BrandStudios.AI. An Ironman-inspired operations interface that
orchestrates the full brand pipeline: ingest, generate, drift-check, and export. This is
the real product — the client-facing tool that runs brand operations.

## Architecture
- **Frontend:** React 19 + TypeScript + Vite + Tailwind v4
- **Backend:** Supabase (Postgres, Realtime) — production. Express (os-api/) — API gateway.
- **Brand Engine:** Python FastAPI sidecar (`brand-engine/`) — Gemini Embed 2 + Cohere v4 dual-fusion for brand compliance. Runs on port 8100.
- **Pipeline:** Four pillars — Brand Memory, Creative Studio, Brand Drift, Insight Loop
- **Embeddings:** Gemini Embedding 2 (768D via MRL) + Cohere v4 (1536D) — dual-fusion z-score normalization
- **Data:** `hud.json` is the UI data source. Supabase tables: `clients`, `runs`, `run_logs`, `artifacts`.
- **Realtime:** Supabase Realtime on `runs` and `run_logs`.

## Connected Repos (wired but optional)
- `Temp-gen/` — Image/video generation CLI (Gemini, Veo) — still subprocess
- `Brand_linter/` — **ARCHIVED** — consolidated into `brand-engine/` (in-repo)
- `BDE/` — **ARCHIVED** — ML code cherry-picked into `brand-engine/`

## Key Files
| File | Purpose |
|------|---------|
| `src/App.tsx` | Main HUD component |
| `src/api.ts` | API client + SSE subscriptions |
| `src/lib/supabase.ts` | Supabase client |
| `hud.json` | Client data + UI config (source of truth) |
| `os-api/` | Express backend (API gateway) |
| `brand-engine/` | Python brand compliance engine (Gemini+Cohere dual-fusion) |
| `supabase/` | Migrations |
| `worker/` | Python worker for HUD run execution |

## Separation from brandstudios-dashboard
These are TWO SEPARATE projects. Never cross the streams:
- `~/proto_front/` — **this project** — the real product HUD (Vite + React)
- `~/brandstudios-dashboard/` — showcase mirror dashboard (Next.js) — reads vault, displays status
- The dashboard mirrors what happens here. This is where the work happens.

## Stack Quick Reference
- Node 22.x (`nvm use`)
- `npm run dev` → HUD at localhost:5173
- `npm run dev:api` → API at localhost:3001
- `npm run dev:engine` → brand-engine API at localhost:8100
- `npm run dev:all` → HUD + API + brand-engine concurrently
- Supabase project: `tfbfzepaccvklpabllao`

## Run Modes
| Mode | Description |
|------|-------------|
| `full` | Complete pipeline: ingest → generate → drift → hitl → export |
| `ingest` | Index brand assets only |
| `images` | Generate images only |
| `video` | Generate video only |
| `drift` | Run drift check only |
| `export` | Package artifacts |

## Rules
- Keep `hud.json` as the source of truth for client/UI data
- Tailwind v4 via Vite plugin — no PostCSS config needed
- Demo mode fallback when external tools unavailable (look for `[DEMO]` prefix)
- Pin all dependencies to exact versions
