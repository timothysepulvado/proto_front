# BrandStudios OS API

Express backend for the BrandStudios OS HUD. Handles run orchestration, SSE log streaming, and artifact management.

## Stack

- **Express** - HTTP server
- **SQLite** (better-sqlite3) - Persistent storage
- **SSE** - Real-time log streaming
- **tsx** - TypeScript execution with watch mode

## Quick Start

```bash
npm install
npm run dev
```

Server runs at http://localhost:3001

## API Endpoints

### Clients

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/clients` | List all clients |
| GET | `/api/clients/:clientId` | Get client with run history |

### Runs

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/clients/:clientId/runs` | Create new run |
| GET | `/api/runs/:runId` | Get run details |
| GET | `/api/runs/:runId/logs` | SSE stream of logs |
| POST | `/api/runs/:runId/cancel` | Cancel active run |

### HITL Review

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/runs/:runId/review` | Get review status |
| POST | `/api/runs/:runId/review/approve` | Approve review |
| POST | `/api/runs/:runId/review/reject` | Reject with notes |

### Artifacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/runs/:runId/artifacts` | List run artifacts |
| POST | `/api/runs/:runId/export` | Trigger export |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |

## Creating a Run

```bash
curl -X POST http://localhost:3001/api/clients/client_cylndr/runs \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}'
```

**Modes:** `full`, `ingest`, `images`, `video`, `drift`, `export`

## SSE Log Streaming

```bash
curl -N http://localhost:3001/api/runs/<runId>/logs
```

Events:
- `message` - Log entry `{ runId, timestamp, stage, level, message }`
- `complete` - Run finished `{ runId, status }`

## Database

SQLite database stored at `data/runs.db` with tables:
- `runs` - Run state and stages
- `run_logs` - Log entries
- `artifacts` - Generated files
- `clients` - Client registry

## Environment

Create `.env` from `.env.example`:

```bash
PORT=3001
TEMP_GEN_PATH=/path/to/Temp-gen
BRAND_LINTER_PATH=/path/to/Brand_linter/local_quick_setup
```

## External Tool Integration

The runner attempts to execute real CLI tools:

| Stage | Tool | Command |
|-------|------|---------|
| ingest | Brand_linter | `python tools/brand_dna_indexer.py --brand <name> --images <path>` |
| generate | Temp-gen | `python main.py nano generate --prompt "..." --output "..."` |
| video | Temp-gen | `python main.py veo generate --prompt "..." --output "..."` |
| drift | Brand_linter | `python tools/image_analyzer.py --image <path>` |

If tools fail, the runner falls back to demo mode with simulated logs.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled JS |
