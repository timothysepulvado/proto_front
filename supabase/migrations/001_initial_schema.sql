-- BrandStudios OS HUD Schema Migration
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/tfbfzepaccvklpabllao/sql

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE run_mode AS ENUM ('full', 'ingest', 'images', 'video', 'drift', 'export');
CREATE TYPE run_status AS ENUM ('pending', 'running', 'needs_review', 'blocked', 'completed', 'failed', 'cancelled');
CREATE TYPE stage_status AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');
CREATE TYPE log_level AS ENUM ('info', 'warn', 'error', 'debug');
CREATE TYPE artifact_type AS ENUM ('image', 'video', 'report', 'package');
CREATE TYPE client_status AS ENUM ('active', 'inactive', 'archived');

-- ============================================
-- TABLES
-- ============================================

-- Clients table
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status client_status NOT NULL DEFAULT 'active',
  last_run_id UUID,
  last_run_at TIMESTAMPTZ,
  last_run_status run_status,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Runs table
CREATE TABLE runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mode run_mode NOT NULL,
  status run_status NOT NULL DEFAULT 'pending',
  stages JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  hitl_required BOOLEAN NOT NULL DEFAULT FALSE,
  hitl_notes TEXT
);

-- Run logs table
CREATE TABLE run_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stage TEXT NOT NULL,
  level log_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL
);

-- Artifacts table
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type artifact_type NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_runs_client_id ON runs(client_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX idx_run_logs_run_id ON run_logs(run_id);
CREATE INDEX idx_run_logs_timestamp ON run_logs(timestamp DESC);
CREATE INDEX idx_artifacts_run_id ON artifacts(run_id);

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_runs_updated_at
  BEFORE UPDATE ON runs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;

-- Public read access (for now - tighten later with auth)
CREATE POLICY "Allow public read on clients" ON clients FOR SELECT USING (true);
CREATE POLICY "Allow public insert on clients" ON clients FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on clients" ON clients FOR UPDATE USING (true);

CREATE POLICY "Allow public read on runs" ON runs FOR SELECT USING (true);
CREATE POLICY "Allow public insert on runs" ON runs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on runs" ON runs FOR UPDATE USING (true);

CREATE POLICY "Allow public read on run_logs" ON run_logs FOR SELECT USING (true);
CREATE POLICY "Allow public insert on run_logs" ON run_logs FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public read on artifacts" ON artifacts FOR SELECT USING (true);
CREATE POLICY "Allow public insert on artifacts" ON artifacts FOR INSERT WITH CHECK (true);

-- ============================================
-- REALTIME (for SSE replacement)
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE run_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE runs;

-- ============================================
-- SEED DATA
-- ============================================

INSERT INTO clients (id, name, status) VALUES
  ('client_cylndr', 'Cylndr', 'active'),
  ('client_jenni_kayne', 'Jenni Kayne', 'active'),
  ('client_lilydale', 'Lilydale', 'active')
ON CONFLICT (id) DO NOTHING;
