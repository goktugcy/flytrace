// Position-stream cadence scenario.
//
// A smaller pool of connections that subscribe to a viewport and *consume* the
// position/event stream, asserting the server pushes updates at a healthy
// cadence (inter-message gap) rather than stalling. Where ws-connections.js
// stresses raw connection count, this one watches per-connection message flow.
//
//   k6 run -e VUS=200 load/scenarios/aircraft-stream.js
//   k6 run -e VUS=1000 -e BASE_URL=http://api.local:3001 load/scenarios/aircraft-stream.js

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomViewport, wsUrlWithTicket } from '../config.js';

const interMessageGap = new Trend('stream_inter_message_gap', true);
const messagesPerConn = new Trend('stream_messages_per_conn');
const eventsReceived = new Counter('stream_events_received');
const streamStalled = new Rate('stream_stalled'); // saw < MIN_MSGS in the window
const ticketFailures = new Counter('stream_ticket_failures');

// A consumer holds for this long and expects at least MIN_MSGS server frames
// (hello + snapshot/events). Tune to your feed cadence.
const HOLD_MS = Number(__ENV.HOLD_MS) > 0 ? Number(__ENV.HOLD_MS) : 60000;
const MIN_MSGS = Number(__ENV.MIN_MSGS) > 0 ? Number(__ENV.MIN_MSGS) : 2;
const VUS = Number(__ENV.VUS) > 0 ? Number(__ENV.VUS) : 200;

export const options = {
  scenarios: {
    aircraft_stream: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: VUS },
        { duration: `${Math.round(HOLD_MS / 1000)}s`, target: VUS },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    stream_stalled: ['rate<0.05'],
    // Cadence guard: 95% of gaps between consecutive frames under 30s.
    stream_inter_message_gap: ['p(95)<30000'],
    checks: ['rate>0.95'],
  },
};

export default function () {
  const url = wsUrlWithTicket();
  if (!url) {
    ticketFailures.add(1);
    sleep(1);
    return;
  }

  let count = 0;
  let lastAt = 0;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      const bbox = randomViewport();
      socket.send(JSON.stringify({ t: 'viewport', bbox, zoom: 7 }));
      socket.setInterval(() => socket.send(JSON.stringify({ t: 'ping' })), 15000);
      socket.setTimeout(() => socket.close(), HOLD_MS);
    });

    socket.on('message', (raw) => {
      const now = Date.now();
      if (lastAt !== 0) interMessageGap.add(now - lastAt);
      lastAt = now;
      count += 1;

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_e) {
        return;
      }
      if (msg.t === 'event' || msg.t === 'snapshot') eventsReceived.add(1);
    });

    socket.on('close', () => {
      messagesPerConn.add(count);
      streamStalled.add(count < MIN_MSGS);
    });
  });

  check(res, {
    'ws status 101': (r) => r && r.status === 101,
    'received cadence': () => count >= MIN_MSGS,
  });
}
