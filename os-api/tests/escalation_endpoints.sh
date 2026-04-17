#!/usr/bin/env bash
# Escalation system smoke tests — run after:
#   1. supabase db push (migration 007 applied)
#   2. os-api running on :3001 (npm run dev:api)
#   3. brand-engine restarted with new code (:8100)
#   4. ANTHROPIC_API_KEY set in os-api/.env
set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
BRAND_ENGINE="${BRAND_ENGINE:-http://localhost:8100}"

fail() { echo "✘ $1"; exit 1; }
pass() { echo "✓ $1"; }

echo "== Phase C2d endpoint smoke tests =="
echo "Base: $BASE"
echo ""

# 1. Catalog populated?
count=$(curl -sf "$BASE/api/known-limitations" | jq 'length')
[ "$count" -ge 7 ] || fail "known_limitations count < 7 (got $count) — run 'supabase db push'"
pass "known_limitations catalog has $count entries"

# 2. Filter by category
atmos=$(curl -sf "$BASE/api/known-limitations?category=atmospheric" | jq 'length')
[ "$atmos" -ge 2 ] || fail "atmospheric filter returned $atmos (expected ≥2)"
pass "category=atmospheric returns $atmos entries"

# 3. Filter by severity
blocking=$(curl -sf "$BASE/api/known-limitations?severity=blocking" | jq 'length')
[ "$blocking" -ge 2 ] || fail "blocking filter returned $blocking (expected ≥2)"
pass "severity=blocking returns $blocking entries"

# 4. Get by id (pluck first)
id=$(curl -sf "$BASE/api/known-limitations" | jq -r '.[0].id')
name=$(curl -sf "$BASE/api/known-limitations/$id" | jq -r '.failureMode')
[ -n "$name" ] || fail "GET /api/known-limitations/$id returned no failureMode"
pass "GET by id → $name"

# 5. Empty escalations initially
esc=$(curl -sf "$BASE/api/escalations" | jq 'length')
pass "escalations count: $esc"

# 6. Health check
ok=$(curl -sf "$BASE/api/health" | jq -r '.status')
[ "$ok" = "ok" ] || fail "health status: $ok"
pass "health: ok"

# 7. brand-engine /grade_video route exists (OPTIONS or /openapi.json)
routes=$(curl -sf "$BRAND_ENGINE/openapi.json" | jq -r '.paths | keys | .[]')
echo "$routes" | grep -q "^/grade_video$" || fail "/grade_video not in brand-engine routes"
pass "brand-engine /grade_video route available"

echo ""
echo "✓ All escalation-system smoke tests passed."
