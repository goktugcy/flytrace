import { pgEnum } from 'drizzle-orm/pg-core';

// See docs/05-database.md §5.9

export const flightStatus = pgEnum('flight_status', [
  'scheduled',
  'active',
  'landed',
  'delayed',
  'cancelled',
  'diverted',
  'unknown',
]);

export const eventType = pgEnum('event_type', [
  'flight_detected',
  'flight_updated',
  'takeoff',
  'landing',
  'climb',
  'descent',
  'top_of_climb',
  'top_of_descent',
  'gate_change',
  'delay',
  'cancelled',
  'entered_airspace',
  'arrived',
  'flight_ended',
  'aircraft_changed',
]);

export const channel = pgEnum('channel', ['telegram', 'webpush', 'email']);

export const notifStatus = pgEnum('notif_status', [
  'queued',
  'sent',
  'delivered',
  'failed',
  'suppressed',
]);

export const userRole = pgEnum('user_role', ['user', 'admin']);

export const favoriteKind = pgEnum('favorite_kind', ['route', 'aircraft', 'airport']);

export const providerHealth = pgEnum('provider_health', ['up', 'degraded', 'down']);
