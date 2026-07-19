// Consolidated load-test report.
//
// Reads every k6 --summary-export JSON in load/results/ (as written by run.sh)
// and prints a single markdown table: throughput, p95 latency, and error rate
// per run, plus a per-scenario best/worst roll-up. Pure Node, no deps.
//
//   node load/report.js                       # all results in load/results/
//   node load/report.js load/results/*.json   # explicit files
//   node load/report.js --out load/results/REPORT.md   # also write to a file
//
// Run names encode scenario + profile: <scenario>-<profile>-<timestamp>.json

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');

function parseArgs(argv) {
  const files = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = argv[++i];
    } else if (a.startsWith('--out=')) {
      out = a.slice('--out='.length);
    } else {
      files.push(a);
    }
  }
  return { files, out };
}

function listResultFiles(explicit) {
  if (explicit.length > 0) return explicit.map((f) => resolve(f));
  let entries;
  try {
    entries = readdirSync(RESULTS_DIR);
  } catch (_e) {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(RESULTS_DIR, f))
    .sort();
}

function num(v, digits = 2) {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits).replace(/\.00$/, '');
}

function ms(v) {
  return v === undefined || v === null ? '—' : `${num(v)} ms`;
}

// Split "<scenario>-<profile>-<timestamp>.json" into parts. Scenario names can
// contain hyphens (api-burst), so profile+timestamp are peeled off the end.
function describeRun(file) {
  const name = basename(file).replace(/\.json$/, '');
  const parts = name.split('-');
  // timestamp = YYYYMMDD-HHMMSS -> last two segments
  let scenario = name;
  let profile = '—';
  let ts = '—';
  if (parts.length >= 3) {
    ts = `${parts[parts.length - 2]}-${parts[parts.length - 1]}`;
    profile = parts[parts.length - 3];
    scenario = parts.slice(0, parts.length - 3).join('-');
  }
  return { scenario, profile, ts };
}

function extract(summary) {
  const m = summary.metrics || {};
  const g = (key) => m[key] || {};

  const httpReqs = g('http_reqs');
  const dur = g('http_req_duration');
  const failed = g('http_req_failed');
  const checks = g('checks');

  // Rate metrics export { value, passes, fails }; Counters export { count, rate }.
  const errorRate =
    failed.value !== undefined
      ? failed.value
      : failed.fails !== undefined && failed.passes !== undefined
        ? failed.fails / Math.max(1, failed.fails + failed.passes)
        : undefined;

  return {
    requests: httpReqs.count,
    rps: httpReqs.rate,
    p95: dur['p(95)'],
    p90: dur['p(90)'],
    avg: dur.avg,
    max: dur.max,
    errorRate,
    checkRate: checks.value,
    // WS-specific (present only in ws scenarios).
    wsConnectP95: (m.ws_connect_time || {})['p(95)'],
    wsHelloP95: (m.ws_time_to_hello || {})['p(95)'],
    wsConnectSuccess: (m.ws_connect_success || {}).value,
    wsMessages: (m.ws_messages_received || m.stream_events_received || {}).count,
    streamGapP95: (m.stream_inter_message_gap || {})['p(95)'],
  };
}

function verdict(x) {
  const p95ok = x.p95 === undefined || x.p95 < 500;
  const errok = x.errorRate === undefined || x.errorRate < 0.01;
  const wsok = x.wsConnectSuccess === undefined || x.wsConnectSuccess > 0.95;
  return p95ok && errok && wsok ? '✅ PASS' : '❌ FAIL';
}

function main() {
  const { files: explicit, out } = parseArgs(process.argv.slice(2));
  const files = listResultFiles(explicit).filter((f) => {
    try {
      return statSync(f).isFile();
    } catch (_e) {
      return false;
    }
  });

  const lines = [];
  const p = (s = '') => lines.push(s);

  p('# FlyTrace Load Test Report');
  p('');
  p(`_Generated ${new Date().toISOString()} from ${files.length} result file(s)._`);
  p('');

  if (files.length === 0) {
    p('No result files found. Run a scenario first:');
    p('');
    p('```sh');
    p('load/run.sh api-burst 1k');
    p('```');
    emit(lines.join('\n'), out);
    return;
  }

  const rows = [];
  for (const file of files) {
    let summary;
    try {
      summary = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      p(`> ⚠️ could not parse \`${basename(file)}\`: ${e.message}`);
      continue;
    }
    rows.push({ ...describeRun(file), ...extract(summary), file });
  }

  // ── HTTP-style throughput/latency table ──
  p('## Runs');
  p('');
  p('| Scenario | Profile | Requests | RPS | p95 | avg | max | Error rate | Checks | Verdict |');
  p('|---|---|--:|--:|--:|--:|--:|--:|--:|:--|');
  for (const r of rows) {
    p(
      `| ${r.scenario} | ${r.profile} | ${r.requests ?? '—'} | ${num(r.rps)} | ` +
        `${ms(r.p95)} | ${ms(r.avg)} | ${ms(r.max)} | ` +
        `${r.errorRate === undefined ? '—' : `${num(r.errorRate * 100)}%`} | ` +
        `${r.checkRate === undefined ? '—' : `${num(r.checkRate * 100)}%`} | ${verdict(r)} |`,
    );
  }
  p('');

  // ── WebSocket roll-up (only rows that carry ws metrics) ──
  const wsRows = rows.filter(
    (r) =>
      r.wsConnectP95 !== undefined || r.wsConnectSuccess !== undefined || r.streamGapP95 !== undefined,
  );
  if (wsRows.length > 0) {
    p('## WebSocket');
    p('');
    p('| Scenario | Profile | Connect p95 | Time-to-hello p95 | Connect success | Msgs recv | Stream gap p95 |');
    p('|---|---|--:|--:|--:|--:|--:|');
    for (const r of wsRows) {
      p(
        `| ${r.scenario} | ${r.profile} | ${ms(r.wsConnectP95)} | ${ms(r.wsHelloP95)} | ` +
          `${r.wsConnectSuccess === undefined ? '—' : `${num(r.wsConnectSuccess * 100)}%`} | ` +
          `${r.wsMessages ?? '—'} | ${ms(r.streamGapP95)} |`,
      );
    }
    p('');
  }

  // ── SLO summary ──
  const failing = rows.filter((r) => verdict(r).startsWith('❌'));
  p('## SLO summary');
  p('');
  p('- Target: **p95 < 500ms**, **error rate < 1%**, **ws connect success > 95%**.');
  p(`- Runs evaluated: **${rows.length}**, failing SLO: **${failing.length}**.`);
  if (failing.length > 0) {
    p('');
    for (const r of failing) {
      p(`  - ❌ \`${r.scenario}\` @ \`${r.profile}\` (${r.ts})`);
    }
  }
  p('');

  emit(lines.join('\n'), out);
}

function emit(md, out) {
  process.stdout.write(`${md}\n`);
  if (out) {
    writeFileSync(resolve(out), `${md}\n`);
    process.stderr.write(`\nwrote ${resolve(out)}\n`);
  }
}

main();
