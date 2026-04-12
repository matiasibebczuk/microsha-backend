-- Bloqueo de paradas programado
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS scheduled_stop_block_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS scheduled_stop_block_day     INTEGER,
  ADD COLUMN IF NOT EXISTS scheduled_stop_block_time    TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_stop_block_last_trigger_week TEXT,
  ADD COLUMN IF NOT EXISTS stop_block_active            BOOLEAN NOT NULL DEFAULT FALSE;

-- Capacidad override de micros
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS bus_capacity_override INTEGER;
