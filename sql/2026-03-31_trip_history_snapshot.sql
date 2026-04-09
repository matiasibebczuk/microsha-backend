-- Historial independiente de trips/trip_runs para conservar registro aunque se elimine el traslado

CREATE TABLE IF NOT EXISTS trip_history_runs (
  id BIGSERIAL PRIMARY KEY,
  source_run_id BIGINT,
  trip_id BIGINT,
  group_id TEXT NOT NULL,
  trip_name TEXT,
  trip_type TEXT,
  trip_departure_datetime TIMESTAMPTZ,
  trip_status_at_finish TEXT,
  taken_by TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ NOT NULL,
  trip_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_history_runs_source_run_id
  ON trip_history_runs (source_run_id)
  WHERE source_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trip_history_runs_group_finished
  ON trip_history_runs (group_id, finished_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS trip_history_passengers (
  id BIGSERIAL PRIMARY KEY,
  history_run_id BIGINT NOT NULL REFERENCES trip_history_runs(id) ON DELETE CASCADE,
  source_run_id BIGINT,
  source_reservation_id BIGINT,
  user_id TEXT,
  user_name TEXT,
  phone TEXT,
  description TEXT,
  dni TEXT,
  member_number TEXT,
  stop_id BIGINT,
  stop_name TEXT,
  status TEXT,
  boarded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_history_passengers_run
  ON trip_history_passengers (history_run_id);
