ALTER TABLE "geofences" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN "dataset_version" text;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN "imported_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN "effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN "effective_to" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_geofences_provider_dataset" ON "geofences" USING btree ("provider","dataset_version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_geofences_provider_dataset_source" ON "geofences" USING btree ("provider","dataset_version","source_id");