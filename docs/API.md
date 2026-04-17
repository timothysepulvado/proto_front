# BrandStudios OS API — Escalation System (added in migration 007)

> Base URL: `http://localhost:3001` (dev) — Express, `os-api/src/index.ts`
> Added: 2026-04-16 (Phase C2d)
> Schema: `supabase/migrations/007_escalation_system.sql`

Request bodies are JSON (`Content-Type: application/json`). Errors return
`{ "error": "<message>" }` with appropriate HTTP status. All timestamps are
ISO-8601 strings.

---

## Known Limitations (catalog of model failure modes)

### `GET /api/known-limitations`

List all known model limitations. Supports filter by `model`, `category`,
`severity`. Ordered by `times_encountered` desc (most-hit first).

**Query params** (all optional):
- `model` — e.g. `veo-3.1-generate-001`
- `category` — `atmospheric` | `temporal` | `character` | `lighting` | `zoom`
- `severity` — `warning` | `blocking`

**Response `200 OK`:** `KnownLimitation[]`

```json
[
  {
    "id": "uuid",
    "model": "veo-3.1-generate-001",
    "category": "atmospheric",
    "failureMode": "atmospheric_creep_fire_smoke_aerial",
    "description": "Extended aerial shots over scenes containing fire/smoke...",
    "mitigation": "Remove fire/smoke from scene description...",
    "severity": "blocking",
    "detectedInProductionId": "drift-mv",
    "timesEncountered": 1,
    "lastEncounteredAt": "2026-04-16T...",
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

**Curl:**
```bash
curl -s 'http://localhost:3001/api/known-limitations?model=veo-3.1-generate-001&severity=blocking'
```

### `GET /api/known-limitations/:id`

Get one limitation by id.

**Response `200 OK`:** `KnownLimitation` | `404` if not found.

### `POST /api/known-limitations`

Add a new limitation (auto-discovered by orchestrator OR manual seed). Idempotent
on `failureMode` — returns `200` with existing record if already present,
`201` with new record otherwise.

**Body:**
```json
{
  "model": "veo-3.1-generate-001",
  "category": "atmospheric",
  "failureMode": "my_new_failure_mode",
  "description": "What happens when this fails...",
  "mitigation": "How to avoid it (optional)",
  "severity": "warning",
  "detectedInProductionId": "drift-mv",
  "detectedInRunId": "uuid (optional)"
}
```

**Responses:**
- `201` — new created
- `200` — already existed, returns existing
- `400` — missing required fields
- `500` — server error

### `PATCH /api/known-limitations/:id`

Update mitigation/description/severity as we learn more. Other fields
are immutable.

**Body:** any subset of `{ description, mitigation, severity }`.

---

## Asset Escalations (per-artifact state machine)

### `GET /api/escalations`

List escalations. Supports filters.

**Query params** (all optional):
- `status` — `in_progress` | `resolved` | `accepted` | `redesigned` | `replaced` | `hitl_required`
- `runId`
- `campaignId` (applies a two-step filter via deliverables)
- `clientId` (applies a two-step filter via runs)

**Response `200 OK`:** `AssetEscalation[]`

```json
[
  {
    "id": "uuid",
    "artifactId": "uuid",
    "deliverableId": "uuid",
    "runId": "uuid",
    "currentLevel": "L3",
    "status": "redesigned",
    "iterationCount": 4,
    "failureClass": "atmospheric_creep_fire_smoke_aerial",
    "knownLimitationId": "uuid",
    "resolutionPath": "redesign",
    "resolutionNotes": "Ground-level wide composition resolved the aerial atmospheric bias.",
    "finalArtifactId": "uuid",
    "resolvedAt": "...",
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

### `GET /api/escalations/:id`

Get one escalation with full `orchestration_decisions` history inline
(returned as `decisions[]` on the escalation object).

**Response `200 OK`:** `AssetEscalation & { decisions: OrchestrationDecisionRecord[] }`

### `GET /api/artifacts/:id/escalation`

Get the escalation for a specific artifact (or 404 if none).

### `GET /api/campaigns/:campaignId/escalations`

Campaign-level escalation dashboard.

**Response `200 OK`:** `AssetEscalation[]`

---

## Run Escalation Report (Final HITL surface)

### `GET /api/runs/:runId/escalation-report`

Full aggregate report for the final-HITL review of a run. Groups all
escalations + orchestration decisions per deliverable, surfaces known
limitations hit, totals cost.

**Response `200 OK`:** `RunEscalationReport`

```json
{
  "runId": "uuid",
  "clientId": "client_driftmv",
  "campaignId": "uuid",
  "status": "needs_review",
  "startedAt": "...",
  "completedAt": "...",
  "deliverables": [
    {
      "deliverable": { /* CampaignDeliverable */ },
      "escalations": [ /* AssetEscalation[] for this deliverable */ ],
      "decisionHistory": [ /* OrchestrationDecisionRecord[] */ ],
      "knownLimitationsHit": [ /* KnownLimitation[] */ ],
      "totalRegenCost": 2.10
    }
  ],
  "aggregate": {
    "totalEscalations": 3,
    "totalOrchestratorCalls": 7,
    "totalOrchestratorCost": 0.42,
    "totalGenerationCost": 0.00,
    "knownLimitationsHit": [
      { "failureMode": "atmospheric_creep_fire_smoke_aerial", "count": 2 }
    ]
  },
  "finalHitl": {
    "status": "pending",
    "reviewedAt": null,
    "reviewerNotes": null
  }
}
```

### `POST /api/runs/:runId/final-hitl/approve`

Client approves the final bundle → run moves to `completed`. Emits the
standard `runEvents.emit("complete:<runId>")` for realtime consumers.

**Body:**
```json
{
  "notes": "Looks great, ship it.",
  "reviewerId": "tim@brandstudios.ai (optional)"
}
```

**Response `200 OK`:** updated `Run` object.

### `POST /api/runs/:runId/final-hitl/reject`

Client rejects with a message. Creates a NEW run in `full` mode for the same
client/campaign, carrying the rejection context as `hitlNotes`. The new run
starts autonomously in the background.

**Body:**
```json
{
  "notes": "Shot 3 is wrong — the subject's jacket drifts from blue to green.",
  "deliverableIds": ["uuid", "uuid"]  // optional: specific deliverables to retry
}
```

**Response `202 Accepted`:**
```json
{
  "originalRunId": "uuid",
  "newRunId": "uuid",
  "status": "rejected_rerun_queued"
}
```

**Errors:**
- `400` — `notes` missing
- `404` — original run not found
- `500` — server error

---

## Orchestrator (introspection + dev replay)

### `GET /api/orchestrator/decisions/:escalationId`

Full decision history for a specific escalation (ordered by iteration).

**Response `200 OK`:** `OrchestrationDecisionRecord[]`

Each record includes `inputContext`, `decision`, model id, token counts,
cost, latency — for audit and RL-corpus use.

### `POST /api/orchestrator/replay`

Dev/test endpoint: replay an escalation input through the live orchestrator
to test prompt or model changes. Does NOT modify the DB or trigger
regeneration.

**Body:**
```json
{
  "artifact": { /* Artifact object */ },
  "qaVerdict": { /* VideoGradeResult or similar */ },
  "promptHistory": [ /* optional PromptHistoryEntry[] */ ],
  "escalationLevel": "L2",
  "attemptCount": 1,
  "deliverableId": "uuid",
  "campaignId": "uuid (optional)",
  "brandSlug": "drift-mv"
}
```

**Response `200 OK`:** `OrchestratorCallResult` (contains `decision`, model
id, token counts, cost, latency).

**Errors:**
- `400` — missing required inputs
- `500` — Claude API error or invalid JSON from model

---

## Event Stream

Realtime events are emitted via the existing `runEvents` EventEmitter +
Supabase Realtime on the three tables:

| Table | Realtime channel |
|---|---|
| `known_limitations` | (future — subscribe to all INSERT/UPDATE) |
| `asset_escalations` | Subscribe on `run_id=eq.<runId>` for per-run streaming |
| `orchestration_decisions` | Subscribe on `run_id=eq.<runId>` for per-decision streaming |

Plus in-process EventEmitter:
- `escalation:<runId>` — fires on every escalation state change (create, level promotion, resolve)

Example subscription in the HUD (React):

```ts
const channel = supabase
  .channel(`escalations:${runId}`)
  .on("postgres_changes",
    { event: "*", schema: "public", table: "asset_escalations", filter: `run_id=eq.${runId}` },
    (payload) => refetchEscalations(runId))
  .subscribe();
```

---

## Type Reference

All types are defined in `os-api/src/types.ts`:

- `KnownLimitation`
- `AssetEscalation`
- `OrchestrationDecisionRecord`
- `OrchestratorDecision`
- `OrchestratorCallResult`
- `VideoGradeResult` (mirrors brand-engine pydantic `VideoGradeResult`)
- `RunEscalationReport`
- `DeliverableEscalationTrail`
- `PromptHistoryEntry`

---

## Related Endpoints on Other Services

### brand-engine sidecar (:8100)

| Endpoint | Purpose |
|---|---|
| `POST /grade_video` | Gemini 3.1 Pro multimodal video critic. Returns `VideoGradeResult`. Called by runner.ts after video generation. See `brand-engine/brand_engine/api/server.py` for full request/response schema. |

### Temp-gen sidecar (:8200)

| Endpoint | Purpose |
|---|---|
| `POST /generate/image` | Still generation (Gemini 3 Pro) — called by runner during regeneration. |
| `POST /generate/video` | Video generation (Veo 3.1) — async + polling. |
| `GET /jobs/:id` | Poll a video job until `status=complete`. |
| `POST /estimate` | Pre-flight cost estimate. |

See `~/Temp-gen/api/server.py` for full schemas.

---

## Testing

Minimal curl smoke tests (run after `supabase db push` applies migration 007):

```bash
# 1. Catalog populated?
curl -s http://localhost:3001/api/known-limitations | jq 'length'
# expected: 7

# 2. Filter by category
curl -s 'http://localhost:3001/api/known-limitations?category=atmospheric' | jq 'length'
# expected: 2

# 3. Empty escalations initially
curl -s http://localhost:3001/api/escalations | jq 'length'
# expected: 0

# 4. Health check
curl -s http://localhost:3001/api/health | jq
# expected: { "status": "ok", "timestamp": "..." }
```

End-to-end integration test (requires a deliberate-fail artifact):
1. Create a campaign with `brand_slug=drift-mv` and a deliverable
2. Start a run — Veo generates, /grade_video flags atmospheric_creep
3. Watch `asset_escalations` table get INSERT rows (realtime)
4. After loop exits, GET /api/runs/:runId/escalation-report — verify aggregate
5. POST /api/runs/:runId/final-hitl/approve — verify run moves to `completed`
