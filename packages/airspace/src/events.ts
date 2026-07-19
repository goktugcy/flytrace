import type { DomainEventInput, EnteredAirspacePayload } from '@flytrace/shared';
import type { EntryDelta } from './airspace-service.ts';

export interface AirspacePositionSample {
  flightId: string;
  at: string;
  lat: number;
  lon: number;
  altFt: number | null;
  source: string;
}

export function enteredAirspaceEventInputs(
  delta: EntryDelta,
  sample: AirspacePositionSample,
): DomainEventInput<EnteredAirspacePayload>[] {
  return delta.entered.map((airspace) => ({
    type: 'EnteredAirspace',
    occurredAt: sample.at,
    dedupeKey: `${sample.flightId}:airspace:${airspace.id}`,
    partitionKey: sample.flightId,
    payload: {
      flightId: sample.flightId,
      geofenceId: airspace.id,
      airspaceName: airspace.name,
      airspaceType: airspace.type,
      at: sample.at,
      position: {
        lat: sample.lat,
        lon: sample.lon,
        altFt: sample.altFt,
        source: sample.source,
      },
    },
  }));
}
