# BrandStudios OS API

Local orchestration service for the HUD. It tracks runs, spawns Temp-gen and Brand linter commands, and streams logs over SSE.

## Setup

```bash
cd os-api
cp .env.example .env
npm install
npm run dev
```

The HUD expects the API on `http://localhost:4001` and proxies `/api` in Vite.

## Endpoints

- `GET /api/clients`
- `GET /api/clients/:clientId`
- `POST /api/clients/:clientId/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/logs` (SSE)
- `POST /api/runs/:runId/cancel`
- `GET /api/runs/:runId/review`
- `POST /api/runs/:runId/review/approve`
- `POST /api/runs/:runId/review/reject`
- `GET /api/runs/:runId/artifacts`
- `POST /api/runs/:runId/export`

## Default CLI wiring

- Brand linter ingest
  - `python tools/ingest_clip768.py data/reference_images/<brand> --brand <brand>`
  - `python tools/ingest_e5_cohere.py data/reference_images/<brand> --brand <brand>`
  - `python tools/ingest_documents.py data/brand_guidelines/<brand> --brand <brand>`
- Temp-gen generate
  - `python main.py nano generate --prompt "..." --output outputs/.../image.png --campaign <runId>`
  - `python main.py veo generate --prompt "..." --output outputs/.../video.mp4 --campaign <runId>`
