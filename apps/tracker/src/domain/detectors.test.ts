import { describe, expect, test } from 'bun:test';
import type { PhaseEventPayload } from '@flytrace/shared';
import frames from '../../fixtures/ist-departure.json' with { type: 'json' };
import { detectStep } from './detectors.ts';
import type { FlightState } from './flight-state.ts';
import { type Position, normalizeStatesResponse } from './position.ts';

const FLIGHT_ID = '00000000-0000-7000-8000-000000000001';

/** Replay the fixture through the detector, threading state. */
function replay(): { events: { type: string; phase?: string }[]; positions: number } {
  let state: FlightState | null = null;
  const events: { type: string; phase?: string }[] = [];
  let positions = 0;

  for (const frame of frames as unknown[]) {
    const [obs] = normalizeStatesResponse(frame);
    if (!obs) continue;
    const res = detectStep(state, obs, FLIGHT_ID, { source: 'fixture' });
    state = res.next;
    for (const e of res.events) {
      if (e.type === 'PositionUpdated') {
        positions += 1;
      } else if (e.type === 'ClimbDetected' || e.type === 'DescentDetected') {
        events.push({ type: e.type, phase: (e.payload as PhaseEventPayload).phase });
      } else {
        events.push({ type: e.type });
      }
    }
  }
  return { events, positions };
}

describe('detectStep — golden track (IST departure → ESB landing)', () => {
  test('produces the exact derived-event sequence', () => {
    const { events } = replay();
    expect(events).toEqual([
      { type: 'FlightDetected' },
      { type: 'ClimbDetected', phase: 'climb' },
      { type: 'TakeoffDetected' },
      { type: 'ClimbDetected', phase: 'top_of_climb' },
      { type: 'DescentDetected', phase: 'top_of_descent' },
      { type: 'LandingDetected' },
    ]);
  });

  test('emits one PositionUpdated per placed frame', () => {
    const { positions } = replay();
    expect(positions).toBe(20);
  });

  test('takeoff and landing fire exactly once', () => {
    const { events } = replay();
    expect(events.filter((e) => e.type === 'TakeoffDetected')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'LandingDetected')).toHaveLength(1);
  });
});

describe('detectStep — invariants', () => {
  const pos = (over: Partial<Position> = {}): Position => ({
    icao24: '4bb1a2',
    callsign: 'THY1TG',
    lat: 41,
    lon: 28,
    altFt: 0,
    headingDeg: 0,
    gsKt: 0,
    vrateFpm: 0,
    onGround: true,
    ts: '2023-11-14T22:13:20.000Z',
    ...over,
  });

  test('first sighting emits FlightDetected + PositionUpdated', () => {
    const res = detectStep(null, pos(), FLIGHT_ID);
    expect(res.accepted).toBe(true);
    expect(res.events.map((e) => e.type)).toEqual(['FlightDetected', 'PositionUpdated']);
  });

  test('drops stale / out-of-order samples', () => {
    const first = detectStep(null, pos({ ts: '2023-11-14T22:13:20.000Z' }), FLIGHT_ID);
    const stale = detectStep(first.next, pos({ ts: '2023-11-14T22:13:10.000Z' }), FLIGHT_ID);
    expect(stale.accepted).toBe(false);
    expect(stale.events).toHaveLength(0);
    expect(stale.next).toBe(first.next);
  });

  test('dedupe keys are stable and unique per derived fact', () => {
    let state: FlightState | null = null;
    const keys: string[] = [];
    for (const frame of frames as unknown[]) {
      const [obs] = normalizeStatesResponse(frame);
      if (!obs) continue;
      const res = detectStep(state, obs, FLIGHT_ID, { source: 'fixture' });
      state = res.next;
      for (const e of res.events) if (e.type !== 'PositionUpdated') keys.push(e.dedupeKey);
    }
    expect(keys).toEqual([
      `${FLIGHT_ID}:detected`,
      `${FLIGHT_ID}:vphase:climb:1`,
      `${FLIGHT_ID}:takeoff`,
      `${FLIGHT_ID}:vphase:top_of_climb:2`,
      `${FLIGHT_ID}:vphase:top_of_descent:3`,
      `${FLIGHT_ID}:landing`,
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
