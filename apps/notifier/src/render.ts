import type { RenderedMessage } from '@flytrace/notifications';
import type { DbEventTypeName, EventEnvelope } from '@flytrace/shared';

/**
 * Renders a channel-agnostic push message from a domain event (docs/10 §10.4).
 * Phase 1 uses the event payload only (icao24/time); richer flight context
 * (flightNumber, route) is layered on when the read model feeds the notifier.
 */
const COPY: Partial<Record<DbEventTypeName, { title: string; verb: string }>> = {
  takeoff: { title: 'Wheels up ✈️', verb: 'departed' },
  landing: { title: 'Landed 🛬', verb: 'has landed' },
  descent: { title: 'Descending', verb: 'started its descent' },
  top_of_descent: { title: 'Top of descent', verb: 'began descending from cruise' },
  climb: { title: 'Climbing', verb: 'is climbing' },
  top_of_climb: { title: 'Reached cruise', verb: 'reached cruise altitude' },
  arrived: { title: 'Arrived', verb: 'arrived at the gate' },
  delay: { title: 'Delayed', verb: 'is delayed' },
  gate_change: { title: 'Gate changed', verb: 'changed gate' },
  cancelled: { title: 'Cancelled', verb: 'was cancelled' },
  flight_ended: { title: 'Flight ended', verb: 'has ended' },
};

export function renderPush(env: EventEnvelope, dbType: DbEventTypeName): RenderedMessage {
  const p = env.payload as { icao24?: string; callsign?: string | null };
  const who = p.callsign ?? p.icao24 ?? 'A tracked flight';
  const copy = COPY[dbType] ?? { title: 'Flight update', verb: 'has an update' };
  return {
    title: copy.title,
    body: `${who} ${copy.verb}.`,
    url: `/flights/id/${env.partitionKey}`,
  };
}
