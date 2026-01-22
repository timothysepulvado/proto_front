-- Migration: 005_add_brand_slug.sql
-- Purpose: Add brand_slug column to clients table for correct Pinecone index naming
-- Dependencies: 001 (clients table)

-- =============================================================================
-- PROBLEM ADDRESSED
-- =============================================================================
-- The pinecone_namespace column stores "jenni_kayne" (with underscore)
-- but Pinecone indexes use "jennikayne" (no underscore).
--
-- This migration adds a brand_slug column that stores the correct URL-safe
-- slug format used in Pinecone index names.
--
-- NAMING CONTRACT:
--   brand_id: "jenni_kayne" (underscores OK, human-readable)
--   brand_slug: "jennikayne" (NO underscores, Pinecone-safe)
--   client_id: "client_jenni_kayne" (Supabase PK with prefix)

-- =============================================================================
-- ADD BRAND_SLUG COLUMN
-- =============================================================================

-- Add the brand_slug column (nullable initially for safe migration)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS brand_slug TEXT;

-- =============================================================================
-- POPULATE EXISTING ROWS
-- =============================================================================
-- Convert existing pinecone_namespace values to correct slugs
-- The transformation removes underscores and spaces, lowercases everything

-- Jenni Kayne
UPDATE clients
SET brand_slug = 'jennikayne'
WHERE id = 'client_jenni_kayne'
  AND (brand_slug IS NULL OR brand_slug != 'jennikayne');

-- Lilydale
UPDATE clients
SET brand_slug = 'lilydale'
WHERE id = 'client_lilydale'
  AND (brand_slug IS NULL OR brand_slug != 'lilydale');

-- Cylndr
UPDATE clients
SET brand_slug = 'cylndr'
WHERE id = 'client_cylndr'
  AND (brand_slug IS NULL OR brand_slug != 'cylndr');

-- Generic update for any other clients (derive slug from pinecone_namespace)
UPDATE clients
SET brand_slug = LOWER(REPLACE(REPLACE(pinecone_namespace, '_', ''), ' ', ''))
WHERE brand_slug IS NULL
  AND pinecone_namespace IS NOT NULL;

-- =============================================================================
-- ADD CONSTRAINTS
-- =============================================================================

-- Make brand_slug NOT NULL after population
-- (Only do this if all rows have a value - use DO block for safety)
DO $$
BEGIN
    -- Check if any NULL values remain
    IF NOT EXISTS (SELECT 1 FROM clients WHERE brand_slug IS NULL) THEN
        -- Safe to add NOT NULL constraint
        ALTER TABLE clients ALTER COLUMN brand_slug SET NOT NULL;
    ELSE
        RAISE NOTICE 'Some clients have NULL brand_slug - constraint not added';
    END IF;
END $$;

-- Add unique constraint on brand_slug
ALTER TABLE clients ADD CONSTRAINT clients_brand_slug_unique UNIQUE (brand_slug);

-- =============================================================================
-- INDEX FOR LOOKUPS
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_clients_brand_slug ON clients(brand_slug);

-- =============================================================================
-- HELPER FUNCTION
-- =============================================================================
-- Function to derive brand_slug from brand_id (matches index_guard.py)

CREATE OR REPLACE FUNCTION get_brand_slug(p_brand_id TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT LOWER(REPLACE(REPLACE(p_brand_id, '_', ''), ' ', ''));
$$;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON COLUMN clients.brand_slug IS 'URL-safe brand slug for Pinecone index names (no underscores)';
COMMENT ON FUNCTION get_brand_slug(TEXT) IS 'Convert brand_id to URL-safe slug for Pinecone (removes underscores/spaces, lowercases)';

-- =============================================================================
-- VERIFICATION QUERY (for manual check)
-- =============================================================================
-- Run this after migration to verify:
--
-- SELECT id, pinecone_namespace, brand_slug,
--        (LOWER(REPLACE(REPLACE(pinecone_namespace, '_', ''), ' ', '')) = brand_slug) as slug_matches
-- FROM clients;
--
-- Expected output:
-- | id                  | pinecone_namespace | brand_slug   | slug_matches |
-- |---------------------|-------------------|--------------|--------------|
-- | client_jenni_kayne  | jenni_kayne       | jennikayne   | true         |
-- | client_lilydale     | lilydale          | lilydale     | true         |
-- | client_cylndr       | cylndr            | cylndr       | true         |
