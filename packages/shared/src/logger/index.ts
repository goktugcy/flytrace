/**
 * Minimal structured JSON logger (dependency-free).
 * - Emits one JSON object per line to stdout/stderr.
 * - Supports child loggers for correlation-id / module binding.
 * - Redacts common secret-ish keys.
 *
 * Swap for pino later behind this same interface without touching callers.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const REDACT_KEYS = new Set([
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'apikey',
]);

export interface Logger {
  level: LogLevel;
  child(bindings: Record<string, unknown>): Logger;
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  base?: Record<string, unknown>;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const base = opts.base ?? {};
  const threshold = LEVELS[level];

  function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[lvl] < threshold) return;
    const record = {
      level: lvl,
      time: new Date().toISOString(),
      msg,
      ...base,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(record);
    if (LEVELS[lvl] >= LEVELS.error) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  return {
    level,
    child(bindings) {
      return createLogger({ level, base: { ...base, ...bindings } });
    },
    trace: (m, f) => emit('trace', m, f),
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
