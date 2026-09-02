-- Migration: Add source_url and source_display_name columns to archon_sources
-- Required for health check validation in main.py
-- Date: 2026-03-05

-- Add source_url column to store the original URL of the source
ALTER TABLE archon_sources ADD COLUMN IF NOT EXISTS source_url text;

-- Add source_display_name column for user-friendly display names
ALTER TABLE archon_sources ADD COLUMN IF NOT EXISTS source_display_name text;

-- Optional: Add comment for documentation
COMMENT ON COLUMN archon_sources.source_url IS 'Original URL of the crawled source';
COMMENT ON COLUMN archon_sources.source_display_name IS 'User-friendly display name for the source';
