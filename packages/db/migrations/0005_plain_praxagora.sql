-- ────────────────────────────────────────────────────────────────────────────
-- P0 security: stop storing raw bearer tokens at rest.
--
-- `sessions.token` and `notification_channels.link_token` held the *raw* value
-- handed to the client, so a database dump was a pile of live credentials.
-- Both become SHA-256 digests (64 lowercase hex chars), matching
-- `hashToken()` in @flytrace/shared — `encode(digest(x,'sha256'),'hex')` is
-- byte-for-byte identical to Node's `createHash('sha256').digest('hex')`.
--
-- The digests are computed IN PLACE from the existing plaintext, so live
-- sessions and pending verification links survive the deploy: no user is
-- signed out. The plaintext columns are dropped in the same transaction, which
-- makes this migration IRREVERSIBLE by design — rolling back the schema cannot
-- recover the raw tokens (that is the point). The documented rollback is to
-- re-add the column empty and let clients re-authenticate; see
-- docs/18-production.md §Rollback.
--
-- Token VALUES are never emitted to logs here: every statement is set-based and
-- Postgres does not echo row data.
-- ────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

-- ── sessions.token → sessions.token_hash ──
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_token_unique";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_id" uuid;--> statement-breakpoint
UPDATE "sessions" SET "token_hash" = encode(digest("token", 'sha256'), 'hex') WHERE "token" IS NOT NULL;--> statement-breakpoint
-- Any row we could not derive a digest for is unusable; drop it rather than
-- leave a NULL that would break the NOT NULL constraint below.
DELETE FROM "sessions" WHERE "token_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
CREATE INDEX "idx_sessions_device" ON "sessions" USING btree ("device_id");--> statement-breakpoint

-- ── notification_channels.link_token → link_token_hash (+ expiry) ──
DROP INDEX "idx_channels_link_token";--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "link_token_hash" text;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "link_token_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "notification_channels"
   SET "link_token_hash" = encode(digest("link_token", 'sha256'), 'hex'),
       -- Pre-existing links were unbounded; give the in-flight ones a short,
       -- explicit grace window instead of grandfathering an eternal token.
       "link_token_expires_at" = now() + interval '24 hours'
 WHERE "link_token" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" DROP COLUMN "link_token";--> statement-breakpoint
CREATE INDEX "idx_channels_link_token_hash" ON "notification_channels" USING btree ("link_token_hash") WHERE "notification_channels"."link_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "idx_channels_link_token_expires" ON "notification_channels" USING btree ("link_token_expires_at") WHERE "notification_channels"."link_token_hash" is not null;--> statement-breakpoint

-- ── refresh tokens: creation stamp + expiry index for reaping ──
ALTER TABLE "refresh_tokens" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_expires" ON "refresh_tokens" USING btree ("expires_at");
