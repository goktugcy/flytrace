// WebSocket fan-out / connection-scale scenario.
//
// Opens many concurrent connections to the gateway (/ws), each minting its own
// single-use ticket, sending a `viewport` message (the map's live subscription),
// holding the socket open, and measuring:
//   - handshake/connect time      (ws_connect_time)
//   - time-to-first server frame  (ws_time_to_hello, the `hello` envelope)
//   - inbound message rate         (ws_messages_received counter)
//
// Concurrency is parametrized: __ENV.VUS overrides the PROFILE preset. Use the
// 50k-ws profile (or VUS=50000) for the connection-storm target.
//
//   k6 run -e PROFILE=1k   load/scenarios/ws-connections.js
//   k6 run -e VUS=50000 -e PROFILE=50k-ws load/scenarios/ws-connections.js

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomViewport, wsPlan, wsUrlWithTicket } from '../config.js';

const connectTime = new Trend('ws_connect_time', true);
const timeToHello = new Trend('ws_time_to_hello', true);
const messagesReceived = new Counter('ws_messages_received');
const eventsReceived = new Counter('ws_events_received');
const ticketFailures = new Counter('ws_ticket_failures');
const connectSuccess = new Rate('ws_connect_success');

const plan = wsPlan();
// Hold each connection open for the profile's hold window (parsed to seconds).
const HOLD_MS = durationToMs(plan.hold);

export const options = {
  scenarios: {
    ws_connections: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: plan.ramp, target: plan.vus },
        { duration: plan.hold, target: plan.vus },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    ws_connect_success: ['rate>0.95'],
    ws_connect_time: ['p(95)<1000'],
    ws_time_to_hello: ['p(95)<1500'],
  },
};

export default function () {
  const url = wsUrlWithTicket();
  if (!url) {
    ticketFailures.add(1);
    connectSuccess.add(false);
    sleep(1);
    return;
  }

  const start = Date.now();
  let helloAt = 0;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      connectTime.add(Date.now() - start);
      // Subscribe to the map viewport (out-of-band, one per connection).
      const bbox = randomViewport();
      socket.send(JSON.stringify({ t: 'viewport', bbox, zoom: 6 }));

      // Hold the connection, heart-beating with pings so the server keeps it.
      socket.setInterval(() => socket.send(JSON.stringify({ t: 'ping' })), 15000);
      socket.setTimeout(() => socket.close(), HOLD_MS);
    });

    socket.on('message', (raw) => {
      messagesReceived.add(1);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_e) {
        return;
      }
      if (msg.t === 'hello' && helloAt === 0) {
        helloAt = Date.now();
        timeToHello.add(helloAt - start);
      }
      if (msg.t === 'event') eventsReceived.add(1);
    });

    socket.on('error', (e) => {
      // Abnormal closes during a 50k storm are expected noise; record + move on.
      if (e && e.error && !`${e.error}`.includes('close')) {
        connectSuccess.add(false);
      }
    });
  });

  const connected = check(res, { 'ws status 101': (r) => r && r.status === 101 });
  connectSuccess.add(connected);
}

function durationToMs(d) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(d).trim());
  if (!m) return 60000;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60000;
    case 'h':
      return n * 3600000;
    default:
      return 60000;
  }
}
