CREATE TYPE "public"."airport_feature_kind" AS ENUM('runway', 'taxiway', 'apron', 'terminal', 'gate', 'hangar', 'parking');--> statement-breakpoint
CREATE TABLE "airport_geometries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"airport_id" uuid NOT NULL,
	"kind" "airport_feature_kind" NOT NULL,
	"ref" text,
	"name" text,
	"geom" geometry(Geometry,4326),
	"source" text DEFAULT 'osm' NOT NULL,
	"osm_id" text,
	"dataset_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "airport_ground_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flight_id" uuid NOT NULL,
	"icao24" text,
	"airport_id" uuid NOT NULL,
	"state" text NOT NULL,
	"previous_state" text,
	"gate_ref" text,
	"runway_ref" text,
	"lat" double precision,
	"lon" double precision,
	"occurred_at" timestamp with time zone NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airport_ground_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "airport_geometries" ADD CONSTRAINT "airport_geometries_airport_id_airports_id_fk" FOREIGN KEY ("airport_id") REFERENCES "public"."airports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airport_ground_events" ADD CONSTRAINT "airport_ground_events_airport_id_airports_id_fk" FOREIGN KEY ("airport_id") REFERENCES "public"."airports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_airport_geometries_geom" ON "airport_geometries" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_airport_geometries_airport_kind" ON "airport_geometries" USING btree ("airport_id","kind");--> statement-breakpoint
CREATE INDEX "idx_airport_ground_events_airport_time" ON "airport_ground_events" USING btree ("airport_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_airport_ground_events_flight_time" ON "airport_ground_events" USING btree ("flight_id","occurred_at");