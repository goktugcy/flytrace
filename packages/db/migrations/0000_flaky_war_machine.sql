CREATE TYPE "public"."channel" AS ENUM('telegram', 'webpush', 'email');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('flight_detected', 'flight_updated', 'takeoff', 'landing', 'climb', 'descent', 'top_of_climb', 'top_of_descent', 'gate_change', 'delay', 'cancelled', 'entered_airspace', 'arrived', 'flight_ended', 'aircraft_changed');--> statement-breakpoint
CREATE TYPE "public"."favorite_kind" AS ENUM('route', 'aircraft', 'airport');--> statement-breakpoint
CREATE TYPE "public"."flight_status" AS ENUM('scheduled', 'active', 'landed', 'delayed', 'cancelled', 'diverted', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."notif_status" AS ENUM('queued', 'sent', 'delivered', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."provider_health" AS ENUM('up', 'degraded', 'down');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "aircraft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"icao24" char(6) NOT NULL,
	"registration" text,
	"type_icao" text,
	"type_name" text,
	"airline_id" uuid,
	"manufacturer" text,
	"built_year" integer,
	"seats" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aircraft_icao24_unique" UNIQUE("icao24"),
	CONSTRAINT "aircraft_registration_unique" UNIQUE("registration")
);
--> statement-breakpoint
CREATE TABLE "airlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iata" char(2),
	"icao" char(3),
	"name" text NOT NULL,
	"callsign" text,
	"country" text,
	"logo_url" text,
	"provider_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airlines_iata_unique" UNIQUE("iata"),
	CONSTRAINT "airlines_icao_unique" UNIQUE("icao")
);
--> statement-breakpoint
CREATE TABLE "airports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iata" char(3),
	"icao" char(4) NOT NULL,
	"name" text NOT NULL,
	"city" text,
	"country" text,
	"location" geography(Point,4326),
	"elevation_ft" integer,
	"timezone" text,
	"runways" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airports_iata_unique" UNIQUE("iata"),
	CONSTRAINT "airports_icao_unique" UNIQUE("icao")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'dark' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"distance_unit" text DEFAULT 'km' NOT NULL,
	"time_format" text DEFAULT '24h' NOT NULL,
	"quiet_hours" jsonb,
	"default_channels" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"image" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "flight_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flight_id" uuid NOT NULL,
	"type" "event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb,
	"dedupe_key" text NOT NULL,
	CONSTRAINT "flight_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "flight_positions" (
	"flight_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"icao24" char(6),
	"location" geography(Point,4326),
	"altitude_ft" integer,
	"geo_altitude_ft" integer,
	"heading_deg" real,
	"ground_speed_kt" real,
	"vertical_rate_fpm" integer,
	"on_ground" boolean DEFAULT false NOT NULL,
	"squawk" text,
	"source" text DEFAULT 'opensky' NOT NULL,
	CONSTRAINT "flight_positions_flight_id_ts_pk" PRIMARY KEY("flight_id","ts")
);
--> statement-breakpoint
CREATE TABLE "flight_status_snapshots" (
	"flight_id" uuid PRIMARY KEY NOT NULL,
	"provider_key" text NOT NULL,
	"status" "flight_status" NOT NULL,
	"gate" text,
	"terminal" text,
	"baggage_belt" text,
	"scheduled_departure" timestamp with time zone,
	"estimated_departure" timestamp with time zone,
	"actual_departure" timestamp with time zone,
	"scheduled_arrival" timestamp with time zone,
	"estimated_arrival" timestamp with time zone,
	"actual_arrival" timestamp with time zone,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flight_tracks_downsampled" (
	"flight_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"location" geography(Point,4326),
	"altitude_ft" integer,
	"heading_deg" real,
	"ground_speed_kt" real,
	CONSTRAINT "flight_tracks_downsampled_flight_id_ts_pk" PRIMARY KEY("flight_id","ts")
);
--> statement-breakpoint
CREATE TABLE "flights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"callsign" text NOT NULL,
	"flight_number" text,
	"airline_id" uuid,
	"aircraft_id" uuid,
	"origin_airport_id" uuid,
	"destination_airport_id" uuid,
	"scheduled_departure" timestamp with time zone,
	"scheduled_arrival" timestamp with time zone,
	"estimated_departure" timestamp with time zone,
	"estimated_arrival" timestamp with time zone,
	"actual_departure" timestamp with time zone,
	"actual_arrival" timestamp with time zone,
	"status" "flight_status" DEFAULT 'unknown' NOT NULL,
	"flight_date" date NOT NULL,
	"last_seen_at" timestamp with time zone,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "favorite_kind" NOT NULL,
	"ref" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"address" jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"link_token" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"flight_id" uuid,
	"match" jsonb NOT NULL,
	"event_types" "event_type"[] NOT NULL,
	"channels" "channel"[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"watchlist_item_id" uuid,
	"flight_event_id" uuid,
	"flight_id" uuid,
	"channel" "channel" NOT NULL,
	"status" "notif_status" DEFAULT 'queued' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb,
	"dedupe_key" text NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate" text NOT NULL,
	"aggregate_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" text NOT NULL,
	"cache_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" text NOT NULL,
	"operation" text NOT NULL,
	"request" jsonb,
	"status_code" integer,
	"latency_ms" integer,
	"success" boolean NOT NULL,
	"error" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb,
	"health" "provider_health" DEFAULT 'down' NOT NULL,
	"circuit_state" text DEFAULT 'closed' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"p50_ms" integer,
	"p95_ms" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aircraft" ADD CONSTRAINT "aircraft_airline_id_airlines_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airlines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_events" ADD CONSTRAINT "flight_events_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_positions" ADD CONSTRAINT "flight_positions_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_status_snapshots" ADD CONSTRAINT "flight_status_snapshots_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_tracks_downsampled" ADD CONSTRAINT "flight_tracks_downsampled_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flights" ADD CONSTRAINT "flights_airline_id_airlines_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airlines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flights" ADD CONSTRAINT "flights_aircraft_id_aircraft_id_fk" FOREIGN KEY ("aircraft_id") REFERENCES "public"."aircraft"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flights" ADD CONSTRAINT "flights_origin_airport_id_airports_id_fk" FOREIGN KEY ("origin_airport_id") REFERENCES "public"."airports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flights" ADD CONSTRAINT "flights_destination_airport_id_airports_id_fk" FOREIGN KEY ("destination_airport_id") REFERENCES "public"."airports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_watchlist_item_id_watchlist_items_id_fk" FOREIGN KEY ("watchlist_item_id") REFERENCES "public"."watchlist_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_flight_event_id_flight_events_id_fk" FOREIGN KEY ("flight_event_id") REFERENCES "public"."flight_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_aircraft_airline" ON "aircraft" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "idx_aircraft_type" ON "aircraft" USING btree ("type_icao");--> statement-breakpoint
CREATE INDEX "idx_airlines_provider_key" ON "airlines" USING btree ("provider_key");--> statement-breakpoint
CREATE INDEX "idx_airports_location" ON "airports" USING gist ("location");--> statement-breakpoint
CREATE INDEX "idx_accounts_user" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "uq_accounts_provider" ON "accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_events_flight_time" ON "flight_events" USING btree ("flight_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_events_type_time" ON "flight_events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_positions_location" ON "flight_positions" USING gist ("location");--> statement-breakpoint
CREATE INDEX "idx_positions_icao24_ts" ON "flight_positions" USING btree ("icao24","ts");--> statement-breakpoint
CREATE INDEX "idx_flight_status_snapshots_provider" ON "flight_status_snapshots" USING btree ("provider_key","fetched_at");--> statement-breakpoint
CREATE INDEX "uq_flights_callsign_date" ON "flights" USING btree ("callsign","flight_date");--> statement-breakpoint
CREATE INDEX "idx_flights_flight_number" ON "flights" USING btree ("flight_number");--> statement-breakpoint
CREATE INDEX "idx_flights_status" ON "flights" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_flights_last_seen" ON "flights" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_flights_active" ON "flights" USING btree ("status") WHERE "flights"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_favorites_user_kind" ON "favorites" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "idx_channels_user" ON "notification_channels" USING btree ("user_id","channel");--> statement-breakpoint
CREATE INDEX "idx_channels_link_token" ON "notification_channels" USING btree ("link_token") WHERE "notification_channels"."link_token" is not null;--> statement-breakpoint
CREATE INDEX "idx_watchlist_user_active" ON "watchlist_items" USING btree ("user_id","active");--> statement-breakpoint
CREATE INDEX "idx_watchlist_flight_active" ON "watchlist_items" USING btree ("flight_id") WHERE "watchlist_items"."active" = true;--> statement-breakpoint
CREATE INDEX "idx_notifications_user_created" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_status" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notifications_event" ON "notifications" USING btree ("flight_event_id");--> statement-breakpoint
CREATE INDEX "idx_audit_actor_time" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "idx_outbox_unpublished" ON "outbox" USING btree ("created_at") WHERE "outbox"."published" = false;--> statement-breakpoint
CREATE INDEX "uq_provider_cache_key" ON "provider_cache" USING btree ("provider_key","cache_key");--> statement-breakpoint
CREATE INDEX "idx_provider_cache_expires" ON "provider_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_provider_logs_key_time" ON "provider_logs" USING btree ("provider_key","created_at");--> statement-breakpoint
CREATE INDEX "idx_provider_logs_success" ON "provider_logs" USING btree ("success","created_at");--> statement-breakpoint
CREATE INDEX "idx_provider_logs_correlation" ON "provider_logs" USING btree ("correlation_id");