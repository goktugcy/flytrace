// HTTP burst against the map-bootstrap read path.
//
//   GET /api/v1/flights/live?bbox=w,s,e,n   (Redis hot-state, viewport-clipped)
//   GET /api/v1/stats/live                  (landing-page live counters)
//
// Ramps to high RPS per the selected PROFILE and enforces the module SLOs:
// p95 < 500ms and error rate < 1%.
//
//   k6 run -e PROFILE=1k load/scenarios/api-burst.js
//   k6 run -e PROFILE=10k -e BASE_URL=http://api.local:3001 load/scenarios/api-burst.js

import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { API, HTTP_THRESHOLDS, bboxQuery, httpStages, randomViewport } from '../config.js';

const flightsLiveDuration = new Trend('flights_live_duration', true);
const statsLiveDuration = new Trend('stats_live_duration', true);
const emptyViewportRate = new Rate('flights_live_empty_viewport');

export const options = {
  scenarios: {
    api_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: httpStages(),
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    ...HTTP_THRESHOLDS,
    'flights_live_duration': ['p(95)<500'],
    'stats_live_duration': ['p(95)<500'],
  },
};

export default function () {
  group('flights/live', () => {
    const bbox = randomViewport();
    const res = http.get(`${API.flightsLive}?bbox=${bboxQuery(bbox)}`, {
      tags: { name: 'flights-live' },
    });
    flightsLiveDuration.add(res.timings.duration);
    check(res, {
      'flights 200': (r) => r.status === 200,
      'flights has array': (r) => {
        try {
          return Array.isArray(r.json('data.flights'));
        } catch (_e) {
          return false;
        }
      },
    });
    try {
      emptyViewportRate.add((res.json('data.count') || 0) === 0);
    } catch (_e) {
      emptyViewportRate.add(true);
    }
  });

  group('stats/live', () => {
    const res = http.get(API.statsLive, { tags: { name: 'stats-live' } });
    statsLiveDuration.add(res.timings.duration);
    check(res, {
      'stats 200': (r) => r.status === 200,
      'stats has counters': (r) => {
        try {
          return typeof r.json('data.flightsLive') === 'number';
        } catch (_e) {
          return false;
        }
      },
    });
  });
}
