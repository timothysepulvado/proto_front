-- Migration: 004_drift_metrics.sql
-- Purpose: Add drift tracking tables for Phase 9 drift monitoring
-- Dependencies: 001 (clients), 002 (campaigns)

-- =============================================================================
-- DRIFT METRICS TABLE
-- =============================================================================
-- Tracks brand drift over time by comparing campaign outputs to Core DNA

CREATE TABLE IF NOT EXISTS drift_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,

    -- Timestamp of measurement
    measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Aggregate scores (z-normalized)
    clip_z FLOAT NOT NULL,
    e5_z FLOAT NOT NULL,
    cohere_z FLOAT NOT NULL,
    fused_z FLOAT NOT NULL,

    -- Drift from baseline (positive = better than baseline, negative = worse)
    clip_drift FLOAT NOT NULL DEFAULT 0,
    e5_drift FLOAT NOT NULL DEFAULT 0,
    cohere_drift FLOAT NOT NULL DEFAULT 0,
    fused_drift FLOAT NOT NULL DEFAULT 0,

    -- Sample size for this measurement
    sample_count INT NOT NULL DEFAULT 0,

    -- Alert threshold breached?
    alert_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    alert_reason TEXT,

    -- Metadata
    metadata JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_drift_metrics_client ON drift_metrics(client_id);
CREATE INDEX IF NOT EXISTS idx_drift_metrics_campaign ON drift_metrics(campaign_id);
CREATE INDEX IF NOT EXISTS idx_drift_metrics_measured_at ON drift_metrics(measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_metrics_alert ON drift_metrics(client_id, alert_triggered) WHERE alert_triggered = TRUE;

-- =============================================================================
-- BRAND BASELINES TABLE
-- =============================================================================
-- Stores baseline scores for drift comparison

CREATE TABLE IF NOT EXISTS brand_baselines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

    -- Baseline scores (z-normalized)
    clip_baseline_z FLOAT NOT NULL,
    e5_baseline_z FLOAT NOT NULL,
    cohere_baseline_z FLOAT NOT NULL,
    fused_baseline_z FLOAT NOT NULL,

    -- Baseline raw scores for reference
    clip_baseline_raw FLOAT NOT NULL,
    e5_baseline_raw FLOAT NOT NULL,
    cohere_baseline_raw FLOAT NOT NULL,

    -- Standard deviations for z-score calculation
    clip_stddev FLOAT NOT NULL DEFAULT 0.1,
    e5_stddev FLOAT NOT NULL DEFAULT 0.1,
    cohere_stddev FLOAT NOT NULL DEFAULT 0.1,

    -- Sample count used to calculate baseline
    sample_count INT NOT NULL DEFAULT 0,

    -- Version tracking
    version INT NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Only one active baseline per client
    CONSTRAINT unique_active_baseline UNIQUE (client_id, is_active) DEFERRABLE INITIALLY DEFERRED
);

-- Index for quick baseline lookup
CREATE INDEX IF NOT EXISTS idx_brand_baselines_client_active ON brand_baselines(client_id) WHERE is_active = TRUE;

-- =============================================================================
-- DRIFT ALERTS TABLE
-- =============================================================================
-- Tracks drift alerts for notification and review

CREATE TABLE IF NOT EXISTS drift_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    drift_metric_id UUID NOT NULL REFERENCES drift_metrics(id) ON DELETE CASCADE,

    -- Alert details
    alert_type TEXT NOT NULL CHECK (alert_type IN ('warning', 'critical', 'recovery')),
    severity FLOAT NOT NULL,  -- 0.0 - 1.0
    message TEXT NOT NULL,

    -- Resolution tracking
    acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    acknowledged_by TEXT,
    acknowledged_at TIMESTAMPTZ,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_drift_alerts_client ON drift_alerts(client_id);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_unresolved ON drift_alerts(client_id) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_drift_alerts_created ON drift_alerts(created_at DESC);

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Get latest drift metrics for a brand
CREATE OR REPLACE FUNCTION get_latest_brand_drift(p_client_id TEXT)
RETURNS TABLE (
    measured_at TIMESTAMPTZ,
    clip_z FLOAT,
    e5_z FLOAT,
    cohere_z FLOAT,
    fused_z FLOAT,
    fused_drift FLOAT,
    alert_triggered BOOLEAN
)
LANGUAGE SQL
STABLE
AS $$
    SELECT
        measured_at,
        clip_z,
        e5_z,
        cohere_z,
        fused_z,
        fused_drift,
        alert_triggered
    FROM drift_metrics
    WHERE client_id = p_client_id
    ORDER BY measured_at DESC
    LIMIT 1;
$$;

-- Get drift trend for a campaign
CREATE OR REPLACE FUNCTION get_campaign_drift_trend(
    p_campaign_id UUID,
    p_days INT DEFAULT 7
)
RETURNS TABLE (
    day DATE,
    avg_fused_z FLOAT,
    avg_fused_drift FLOAT,
    sample_count BIGINT
)
LANGUAGE SQL
STABLE
AS $$
    SELECT
        DATE(measured_at) as day,
        AVG(fused_z) as avg_fused_z,
        AVG(fused_drift) as avg_fused_drift,
        SUM(sample_count) as sample_count
    FROM drift_metrics
    WHERE campaign_id = p_campaign_id
      AND measured_at >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY DATE(measured_at)
    ORDER BY day DESC;
$$;

-- Get active baseline for a brand
CREATE OR REPLACE FUNCTION get_brand_baseline(p_client_id TEXT)
RETURNS TABLE (
    clip_baseline_z FLOAT,
    e5_baseline_z FLOAT,
    cohere_baseline_z FLOAT,
    fused_baseline_z FLOAT,
    clip_stddev FLOAT,
    e5_stddev FLOAT,
    cohere_stddev FLOAT
)
LANGUAGE SQL
STABLE
AS $$
    SELECT
        clip_baseline_z,
        e5_baseline_z,
        cohere_baseline_z,
        fused_baseline_z,
        clip_stddev,
        e5_stddev,
        cohere_stddev
    FROM brand_baselines
    WHERE client_id = p_client_id AND is_active = TRUE
    LIMIT 1;
$$;

-- Calculate z-score from raw score
CREATE OR REPLACE FUNCTION calculate_z_score(
    p_raw FLOAT,
    p_mean FLOAT,
    p_stddev FLOAT
)
RETURNS FLOAT
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_stddev = 0 THEN 0
        ELSE (p_raw - p_mean) / p_stddev
    END;
$$;

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE drift_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE drift_alerts ENABLE ROW LEVEL SECURITY;

-- Service role has full access
CREATE POLICY drift_metrics_service_policy ON drift_metrics
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY brand_baselines_service_policy ON brand_baselines
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY drift_alerts_service_policy ON drift_alerts
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE drift_metrics IS 'Tracks brand drift by comparing campaign outputs to Core DNA baselines';
COMMENT ON TABLE brand_baselines IS 'Stores baseline z-scores and standard deviations for drift calculation';
COMMENT ON TABLE drift_alerts IS 'Drift alerts for notification and review workflow';

COMMENT ON COLUMN drift_metrics.clip_z IS 'Z-normalized CLIP visual similarity score';
COMMENT ON COLUMN drift_metrics.e5_z IS 'Z-normalized E5 semantic similarity score';
COMMENT ON COLUMN drift_metrics.cohere_z IS 'Z-normalized Cohere multimodal similarity score';
COMMENT ON COLUMN drift_metrics.fused_z IS 'Z-normalized fused score (weighted combination)';
COMMENT ON COLUMN drift_metrics.fused_drift IS 'Drift from baseline: positive=better, negative=worse';
