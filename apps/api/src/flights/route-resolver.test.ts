import { describe, expect, test } from 'bun:test';
import { routeMatchesObservation } from './route-resolver.ts';

const istToAyt = {
  origin: { iata: 'IST', name: 'Istanbul', city: 'Istanbul', lat: 41.2753, lon: 28.7519 },
  destination: { iata: 'AYT', name: 'Antalya', city: 'Antalya', lat: 36.8987, lon: 30.8005 },
};

describe('routeMatchesObservation', () => {
  test('accepts an aircraft flying along the scheduled leg', () => {
    expect(
      routeMatchesObservation(istToAyt, {
        lat: 39.2,
        lon: 29.7,
        headingDeg: 160,
        onGround: false,
      }),
    ).toBe(true);
  });

  test('rejects the reverse leg when the aircraft is flying away from its destination', () => {
    expect(
      routeMatchesObservation(
        { origin: istToAyt.destination, destination: istToAyt.origin },
        { lat: 39.2, lon: 29.7, headingDeg: 160, onGround: false },
      ),
    ).toBe(false);
  });

  test('rejects a route whose great-circle corridor is far from the aircraft', () => {
    expect(
      routeMatchesObservation(istToAyt, {
        lat: 51.5,
        lon: -0.1,
        headingDeg: 90,
        onGround: false,
      }),
    ).toBe(false);
  });

  test('does not reject normal turns close to an endpoint', () => {
    expect(
      routeMatchesObservation(istToAyt, {
        lat: 36.95,
        lon: 30.7,
        headingDeg: 340,
        onGround: false,
      }),
    ).toBe(true);
  });
});
