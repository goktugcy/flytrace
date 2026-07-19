-- ============================================================================
-- OPTIONAL: TimescaleDB setup for the flight_positions timeseries.
--
-- This file is NOT wired into drizzle's migration meta and is NEVER run by
-- `drizzle-kit migrate`. Apply it by hand (or via ops tooling) ONLY when running
-- against a TimescaleDB-enabled Postgres and after setting TIMESERIES_BACKEND=timescale.
-- Plain Postgres (the default backend) needs none of this.
--
-- Prerequisite: the base drizzle migration (0000_*.sql) must already have created
-- the `flight_positions` table. Converting an existing table to a hypertable is
-- supported by create_hypertable with migrate_data => true.
-- ============================================================================

-- 1) Extension ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 2) Hypertable --------------------------------------------------------------
-- Partition flight_positions by its `ts` column. The (flight_id, ts) primary key
-- already includes the partitioning column, which Timescale requires.
-- `migrate_data => true` moves any existing rows into chunks.
SELECT create_hypertable(
  'flight_positions',
  'ts',
  chunk_time_interval => interval '1 day',
  migrate_data        => true,
  if_not_exists       => true
);

-- 3) Continuous aggregates ---------------------------------------------------
-- Pre-materialized 1-minute rollups backing altitudeHistory()/speedHistory() on
-- the Timescale backend. The repo can be pointed at these views instead of the
-- raw table for cheap long-range history reads.

-- Altitude rollup.
CREATE MATERIALIZED VIEW IF NOT EXISTS flight_positions_altitude_1m
WITH (timescaledb.continuous) AS
SELECT
  flight_id,
  time_bucket(interval '1 minute', ts) AS bucket,
  round(avg(altitude_ft))::int         AS altitude_ft
FROM flight_positions
GROUP BY flight_id, bucket
WITH NO DATA;

-- Ground-speed rollup.
CREATE MATERIALIZED VIEW IF NOT EXISTS flight_positions_speed_1m
WITH (timescaledb.continuous) AS
SELECT
  flight_id,
  time_bucket(interval '1 minute', ts) AS bucket,
  avg(ground_speed_kt)                 AS ground_speed_kt
FROM flight_positions
GROUP BY flight_id, bucket
WITH NO DATA;

-- 4) Refresh + retention policies -------------------------------------------
-- Keep the continuous aggregates fresh.
SELECT add_continuous_aggregate_policy('flight_positions_altitude_1m',
  start_offset      => interval '3 hours',
  end_offset        => interval '1 minute',
  schedule_interval => interval '1 minute');

SELECT add_continuous_aggregate_policy('flight_positions_speed_1m',
  start_offset      => interval '3 hours',
  end_offset        => interval '1 minute',
  schedule_interval => interval '1 minute');

-- Retention: drop raw chunks older than 30 days (mirrors buildRetentionSql()).
-- Continuous aggregates retain their rollups independently.
SELECT add_retention_policy('flight_positions', drop_after => interval '30 days');

-- Optional: compress older chunks to save space.
-- ALTER TABLE flight_positions SET (
--   timescaledb.compress,
--   timescaledb.compress_segmentby = 'flight_id'
-- );
-- SELECT add_compression_policy('flight_positions', compress_after => interval '7 days');
