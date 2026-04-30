export type AuditVerdict = "PASS" | "WARN" | "FAIL";
export type AuditRecommendation = "ship" | "L1_prompt_fix" | "L2_approach_change" | "L3_redesign";
export type AuditRecommendationBucket = "KEEP" | "L1" | "L2" | "L3" | "ERROR";

export const AUDIT_CRITIC_UNIT_COST = 0.1;

export interface AuditReportSummary {
  keep: number;
  l1: number;
  l2: number;
  l3: number;
  errors: number;
  totalCost: number;
}

export interface AuditReportShot {
  shotId: number;
  imagePath: string;
  verdict: AuditVerdict | null;
  aggregateScore: number | null;
  recommendation: AuditRecommendation | null;
  detectedFailureClasses: string[];
  cost: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
}

export interface AuditReport {
  runId: string;
  traceId: string | null;
  productionSlug: string | null;
  completedAt: string | null;
  summary: AuditReportSummary;
  shots: AuditReportShot[];
}

const EMPTY_SUMMARY: AuditReportSummary = {
  keep: 0,
  l1: 0,
  l2: 0,
  l3: 0,
  errors: 0,
  totalCost: 0,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeVerdict(value: string | null): AuditVerdict | null {
  if (value === "PASS" || value === "WARN" || value === "FAIL") return value;
  return null;
}

function normalizeRecommendation(value: string | null): AuditRecommendation | null {
  if (
    value === "ship" ||
    value === "L1_prompt_fix" ||
    value === "L2_approach_change" ||
    value === "L3_redesign"
  ) {
    return value;
  }
  return null;
}

export function getAuditRecommendationBucket(recommendation: AuditRecommendation | null, hasError = false): AuditRecommendationBucket {
  if (hasError) return "ERROR";
  if (recommendation === "L1_prompt_fix") return "L1";
  if (recommendation === "L2_approach_change") return "L2";
  if (recommendation === "L3_redesign") return "L3";
  return "KEEP";
}

export function formatAuditRecommendation(recommendation: AuditRecommendation | null, hasError = false): string {
  if (hasError) return "ERROR";
  if (recommendation === "L1_prompt_fix") return "L1";
  if (recommendation === "L2_approach_change") return "L2";
  if (recommendation === "L3_redesign") return "L3";
  return "KEEP";
}

export function buildAuditSummary(shots: AuditReportShot[]): AuditReportSummary {
  return shots.reduce<AuditReportSummary>((summary, shot) => {
    if (shot.errorMessage || !shot.verdict) {
      summary.errors += 1;
    } else if (shot.recommendation === "L1_prompt_fix") {
      summary.l1 += 1;
    } else if (shot.recommendation === "L2_approach_change") {
      summary.l2 += 1;
    } else if (shot.recommendation === "L3_redesign") {
      summary.l3 += 1;
    } else {
      summary.keep += 1;
    }
    summary.totalCost += shot.cost ?? 0;
    return summary;
  }, { ...EMPTY_SUMMARY });
}

export function parseAuditReportShot(value: unknown): AuditReportShot | null {
  const record = asRecord(value);
  if (!record) return null;
  const shotId = readNumber(record, "shotId") ?? readNumber(record, "shot_id") ?? readNumber(record, "shot");
  if (shotId === null) return null;

  const errorMessage = readString(record, "errorMessage") ?? readString(record, "error_message");
  return {
    shotId,
    imagePath: readString(record, "imagePath") ?? readString(record, "image_path") ?? readString(record, "path") ?? "",
    verdict: normalizeVerdict(readString(record, "verdict")),
    aggregateScore: readNumber(record, "aggregateScore") ?? readNumber(record, "aggregate_score") ?? readNumber(record, "score"),
    recommendation: normalizeRecommendation(readString(record, "recommendation")),
    detectedFailureClasses: readStringArray(record.detectedFailureClasses ?? record.detected_failure_classes ?? record.failureClasses ?? record.failure_classes),
    cost: readNumber(record, "cost"),
    latencyMs: readNumber(record, "latencyMs") ?? readNumber(record, "latency_ms"),
    errorMessage,
  };
}

function parseSummary(value: unknown, shots: AuditReportShot[]): AuditReportSummary {
  const record = asRecord(value);
  if (!record) return buildAuditSummary(shots);
  return {
    keep: readNumber(record, "keep") ?? 0,
    l1: readNumber(record, "l1") ?? 0,
    l2: readNumber(record, "l2") ?? 0,
    l3: readNumber(record, "l3") ?? 0,
    errors: readNumber(record, "errors") ?? 0,
    totalCost: readNumber(record, "totalCost") ?? readNumber(record, "total_cost") ?? 0,
  };
}

export function parseAuditReport(value: unknown): AuditReport | null {
  const record = asRecord(value);
  if (!record) return null;
  const runId = readString(record, "runId") ?? readString(record, "run_id");
  const rawShots = Array.isArray(record.shots) ? record.shots : [];
  const shots = rawShots
    .map(parseAuditReportShot)
    .filter((shot): shot is AuditReportShot => shot !== null)
    .sort((left, right) => left.shotId - right.shotId);

  if (!runId && shots.length === 0) return null;

  return {
    runId: runId ?? "",
    traceId: readString(record, "traceId") ?? readString(record, "trace_id"),
    productionSlug: readString(record, "productionSlug") ?? readString(record, "production_slug"),
    completedAt: readString(record, "completedAt") ?? readString(record, "completed_at"),
    summary: parseSummary(record.summary, shots),
    shots,
  };
}

export function parseAuditVerdictLog(message: string): AuditReportShot | null {
  if (!message.includes("[audit_verdict")) return null;

  const pairs = new Map<string, string>();
  const pattern = /(\w+)=([^\s]+)/g;
  for (const match of message.matchAll(pattern)) {
    pairs.set(match[1], match[2]);
  }

  const shotId = Number(pairs.get("shot"));
  if (!Number.isFinite(shotId)) return null;

  const failureValue = pairs.get("failure_classes") ?? "";
  const detectedFailureClasses = failureValue && failureValue !== "none"
    ? failureValue.split(",").map((item) => item.trim()).filter(Boolean)
    : [];

  return {
    shotId,
    imagePath: pairs.get("path") ?? "",
    verdict: normalizeVerdict(pairs.get("verdict") ?? null),
    aggregateScore: readNumber(Object.fromEntries(pairs), "score"),
    recommendation: normalizeRecommendation(pairs.get("recommendation") ?? null),
    detectedFailureClasses,
    cost: readNumber(Object.fromEntries(pairs), "cost"),
    latencyMs: readNumber(Object.fromEntries(pairs), "latency_ms"),
    errorMessage: null,
  };
}

export function upsertAuditShot(shots: AuditReportShot[], nextShot: AuditReportShot): AuditReportShot[] {
  const index = shots.findIndex((shot) => shot.shotId === nextShot.shotId);
  if (index === -1) return [...shots, nextShot].sort((left, right) => left.shotId - right.shotId);
  const next = [...shots];
  next[index] = nextShot;
  return next.sort((left, right) => left.shotId - right.shotId);
}

export function sortAuditShots(shots: AuditReportShot[], mode: "shot" | "risk"): AuditReportShot[] {
  const riskRank: Record<AuditRecommendationBucket, number> = {
    ERROR: 0,
    L3: 1,
    L2: 2,
    L1: 3,
    KEEP: 4,
  };

  return [...shots].sort((left, right) => {
    if (mode === "risk") {
      const leftRank = riskRank[getAuditRecommendationBucket(left.recommendation, Boolean(left.errorMessage))];
      const rightRank = riskRank[getAuditRecommendationBucket(right.recommendation, Boolean(right.errorMessage))];
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftScore = left.aggregateScore ?? Number.POSITIVE_INFINITY;
      const rightScore = right.aggregateScore ?? Number.POSITIVE_INFINITY;
      if (leftScore !== rightScore) return leftScore - rightScore;
    }
    return left.shotId - right.shotId;
  });
}
