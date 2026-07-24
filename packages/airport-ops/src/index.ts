/**
 * @flytrace/airport-ops — airport ground-movement domain (pure). The tracker
 * preloads an {@link AirportGroundIndex} per airport and calls
 * {@link stepGroundState} on each position to classify AT_GATE/PUSHBACK/TAXI/
 * HOLD_SHORT/LINE_UP/TAKEOFF_ROLL/AIRBORNE and the arrival mirror.
 */
export * from './types.ts';
export * from './geo.ts';
export * from './spatial.ts';
export * from './state-machine.ts';
