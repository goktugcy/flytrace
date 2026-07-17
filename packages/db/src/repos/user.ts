import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import { userSettings as settingsTable } from '../schema/auth.ts';
import { favorites } from '../schema/personalization.ts';

/**
 * User-personalization persistence (docs/11 §11.6): favorites, settings
 * (incl. quiet hours consumed by the notifier), and connected channels.
 */
export type FavoriteKind = (typeof favorites.kind.enumValues)[number];

export interface SettingsPatch {
  theme?: string | undefined;
  locale?: string | undefined;
  distanceUnit?: string | undefined;
  timeFormat?: string | undefined;
  quietHours?: { tz: string; start: string; end: string } | null | undefined;
  defaultChannels?: string[] | undefined;
}

export function createUserRepo(db: Database) {
  return {
    // ── favorites ──
    async createFavorite(
      userId: string,
      kind: FavoriteKind,
      ref: unknown,
    ): Promise<{ id: string }> {
      const [row] = await db
        .insert(favorites)
        .values({ userId, kind, ref })
        .returning({ id: favorites.id });
      return row as { id: string };
    },
    async listFavorites(userId: string): Promise<unknown[]> {
      return db.execute(sql`
        select id, kind, ref, created_at as "createdAt"
        from favorites where user_id = ${userId} order by created_at desc
      `) as unknown as unknown[];
    },
    async deleteFavorite(id: string, userId: string): Promise<boolean> {
      const rows = (await db
        .delete(favorites)
        .where(and(eq(favorites.id, id), eq(favorites.userId, userId)))
        .returning({ id: favorites.id })) as { id: string }[];
      return rows.length > 0;
    },

    // ── settings ──
    async getSettings(userId: string): Promise<Record<string, unknown> | null> {
      const rows = (await db.execute(sql`
        select theme, locale, distance_unit as "distanceUnit", time_format as "timeFormat",
               quiet_hours as "quietHours", default_channels as "defaultChannels"
        from user_settings where user_id = ${userId} limit 1
      `)) as unknown as Record<string, unknown>[];
      return rows[0] ?? null;
    },
    async upsertSettings(userId: string, patch: SettingsPatch): Promise<void> {
      await db
        .insert(settingsTable)
        .values({
          userId,
          ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
          ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
          ...(patch.distanceUnit !== undefined ? { distanceUnit: patch.distanceUnit } : {}),
          ...(patch.timeFormat !== undefined ? { timeFormat: patch.timeFormat } : {}),
          ...(patch.quietHours !== undefined ? { quietHours: patch.quietHours } : {}),
          ...(patch.defaultChannels !== undefined
            ? { defaultChannels: patch.defaultChannels }
            : {}),
        })
        .onConflictDoUpdate({
          target: settingsTable.userId,
          set: {
            ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
            ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
            ...(patch.distanceUnit !== undefined ? { distanceUnit: patch.distanceUnit } : {}),
            ...(patch.timeFormat !== undefined ? { timeFormat: patch.timeFormat } : {}),
            ...(patch.quietHours !== undefined ? { quietHours: patch.quietHours } : {}),
            ...(patch.defaultChannels !== undefined
              ? { defaultChannels: patch.defaultChannels }
              : {}),
            updatedAt: new Date(),
          },
        });
    },

    // ── connected channels (masked address) ──
    async listChannels(userId: string): Promise<unknown[]> {
      return db.execute(sql`
        select id, channel, verified, enabled, created_at as "createdAt",
               coalesce(address->>'email', case when address ? 'chatId' then 'telegram' else 'push' end) as "label"
        from notification_channels where user_id = ${userId} order by created_at desc
      `) as unknown as unknown[];
    },
  };
}

export type UserRepo = ReturnType<typeof createUserRepo>;
