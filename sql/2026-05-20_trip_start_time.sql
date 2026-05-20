-- Migration: Add start_time field to trips table
-- Date: 2026-05-20
-- Purpose: Store the trip start time separately from first stop time

ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_time TEXT;

-- Create index for sorting by start time
CREATE INDEX IF NOT EXISTS idx_trips_start_time ON trips(start_time);
