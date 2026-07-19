ALTER TABLE "airports" ALTER COLUMN "icao" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "airports" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "airports" ADD COLUMN "scheduled_service" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "airports" ADD COLUMN "home_url" text;--> statement-breakpoint
ALTER TABLE "airports" ADD COLUMN "wikipedia_url" text;--> statement-breakpoint
ALTER TABLE "airports" ADD COLUMN "keywords" text;--> statement-breakpoint
CREATE INDEX "idx_airports_type" ON "airports" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_airports_scheduled_service" ON "airports" USING btree ("scheduled_service");