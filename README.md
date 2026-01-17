# BrandStudios OS HUD

React + TypeScript HUD for BrandStudios.ai OS. Features a draggable Ironman-inspired interface with real-time pipeline execution, SSE log streaming, and integration with external creative tools.

## Architecture

```
HUD/
├── src/              # React frontend (Vite + Tailwind v4)
│   └── lib/supabase.ts  # Supabase client
├── os-api/           # Express backend (SQLite + SSE) - legacy/local dev
├── supabase/         # Supabase migrations
├── hud.json          # UI data source
├── .mcp.json         # Supabase MCP config
└── package.json      # Monorepo scripts
```

## Backend

**Supabase** (production):
- Project: `tfbfzepaccvklpabllao`
- Tables: `clients`, `runs`, `run_logs`, `artifacts`
- Realtime enabled on `runs` and `run_logs`

**os-api** (local dev):
- Express + SQLite fallback for offline development

**External repos (wired but optional):**
- `Temp-gen/` - Image/video generation CLI (Gemini, Veo)
- `Brand_linter/` - Brand DNA indexing and drift analysis

## Requirements

- Node 22.x (see `.nvmrc`)
- npm 10.x

## Quick Start

```bash
# Install dependencies
nvm use
npm install
cd os-api && npm install && cd ..

# Set up environment (copy and fill in values)
cp .env.example .env

# Run both HUD and API
npm run dev:all
```

### Environment Variables

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key_here
```

This starts:
- **HUD**: http://localhost:5173 (or next available port)
- **API**: http://localhost:3001

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | HUD only |
| `npm run dev:api` | API only |
| `npm run dev:all` | Both concurrently |
| `npm run build` | Build HUD |
| `npm run build:api` | Build API |

## Four Pillars

The HUD organizes brand operations into four pillars:

1. **Brand Memory** - Ingest and index brand assets (CLIP embeddings → vector store)
2. **Creative Studio** - Generate images/video with brand context
3. **Brand Drift** - Check generated content against brand guidelines
4. **Insight Loop** - Analytics and learning (placeholder)

## Run Modes

| Mode | Stages | Description |
|------|--------|-------------|
| `full` | ingest → generate → drift → hitl → export | Complete pipeline |
| `ingest` | ingest | Index brand assets only |
| `images` | generate_images | Generate images only |
| `video` | generate_video | Generate video only |
| `drift` | drift | Run drift check only |
| `export` | export | Package artifacts |

## Demo Mode

If external tools (Temp-gen, Brand_linter) aren't available or fail, the runner falls back to demo mode with simulated logs. Look for `[DEMO]` prefix in the Run Feed.

## Files

- `hud.json` - Source of truth for client data and UI config
- `src/App.tsx` - Main HUD component with Tailwind styling
- `src/api.ts` - API client with SSE subscription
- `os-api/` - Backend server (see `os-api/README.md`)

## Notes

- Tailwind v4 via Vite plugin
- Background/noise assets in `src/assets/`
- Static preview backup at `docs/static-preview.html`
