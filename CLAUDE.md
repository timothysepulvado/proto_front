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
- **Backend:** Supabase (Postgres, Realtime) — production. Express os-api/ as orchestration layer.
- **Brand Engine:** Python FastAPI sidecar (`brand-engine/`) — Gemini Embed 2 + Cohere v4 dual fusion for ingest, retrieve, drift.
- **Pipeline:** Five pillars — Brand Memory, Creative Studio, Brand Drift, Review Gate, Insight Loop
- **Data:** `hud.json` is the UI data source. Supabase tables (15): `clients`, `runs`, `run_logs`, `artifacts`, `campaigns`, `campaign_deliverables`, `campaign_memory`, `hitl_decisions`, `rejection_categories`, `drift_metrics`, `drift_alerts`, `brand_baselines`, `prompt_templates`, `prompt_scores`, `prompt_evolution_log`.
- **Realtime:** SSE log streaming for pipeline execution. Supabase Realtime on `runs`, `run_logs`, `clients`, `campaigns`, `campaign_deliverables`, `hitl_decisions`, `drift_metrics`, `drift_alerts`.
- **Storage:** Supabase Storage bucket `artifacts` for generated images/videos. Public URLs in artifacts table.

## Connected Repos (wired but optional)
- `Temp-gen/` — Image/video generation CLI (Gemini 3 Pro, Veo 3.1, Sora 2)
- `Brand_linter/` — Legacy brand compliance CLI (being superseded by brand-engine sidecar)
- `brand-engine/` — Consolidated SDK inside this repo. Dual-fusion embeddings, drift scoring, RL trainer.

## Key Files
| File | Purpose |
|------|---------|
| `src/App.tsx` | Main HUD component — 5 pillar tabs, run controls |
| `src/api.ts` | Frontend Supabase client — types, queries, realtime subscriptions |
| `src/components/ReviewPanel.tsx` | HITL review UI — artifact preview, grading, rejection categories |
| `src/components/DeliverableTracker.tsx` | Campaign deliverable status with realtime updates |
| `src/components/DriftAlertPanel.tsx` | Drift alert surfacing, severity badges, acknowledgment with realtime |
| `src/lib/supabase.ts` | Supabase client config |
| `hud.json` | Client data + UI config (source of truth) |
| `os-api/src/index.ts` | Express API routes (runs, HITL, campaigns, deliverables, drift, prompts) |
| `os-api/src/runner.ts` | Pipeline executor — calls brand-engine sidecar + Temp-gen |
| `os-api/src/db.ts` | Supabase query layer — typed mappers for all tables |
| `os-api/src/types.ts` | Shared types — Run, Artifact, Campaign, CampaignDeliverable, DriftAlert, DriftMetric, etc. |
| `os-api/src/storage.ts` | Supabase Storage upload utility |
| `supabase/migrations/` | 5 migrations (001-005) |
| `worker/` | Python worker for HUD run execution |
| `brand-engine/` | Python SDK — embeddings, retrieval, drift scoring |

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
