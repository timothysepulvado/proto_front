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
- **Backend:** Supabase (Postgres, Realtime) — production. Express + SQLite (os-api/) — local dev fallback.
- **Pipeline:** Four pillars — Brand Memory, Creative Studio, Brand Drift, Insight Loop
- **Data:** `hud.json` is the UI data source. Supabase tables: `clients`, `runs`, `run_logs`, `artifacts`.
- **Realtime:** SSE log streaming for pipeline execution. Supabase Realtime on `runs` and `run_logs`.

## Connected Repos (wired but optional)
- `Temp-gen/` — Image/video generation CLI (Gemini, Veo)
- `Brand_linter/` — Brand DNA indexing and drift analysis
- More connections TBD — this HUD orchestrates multiple tools

## Key Files
| File | Purpose |
|------|---------|
| `src/App.tsx` | Main HUD component |
| `src/api.ts` | API client + SSE subscriptions |
| `src/lib/supabase.ts` | Supabase client |
| `hud.json` | Client data + UI config (source of truth) |
| `os-api/` | Express backend (local dev) |
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
- `npm run dev:all` → both concurrently
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
