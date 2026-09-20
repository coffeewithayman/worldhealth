import { appendFileSync } from 'node:fs';
import { redactUrl } from './http.js';

/**
 * Structured logging.
 *
 * Three rules shape this file:
 *
 * 1. **Logs go to stderr, never stdout.** The CLI's stdout is a human report —
 *    coloured tables, score bars — and a scheduler that pipes it somewhere must
 *    not find log lines interleaved with it. `npm run daily > report.txt` keeps
 *    the report clean and the diagnostics on the terminal.
 * 2. **Machine-readable when nobody is watching.** A TTY gets aligned text; a
 *    cron job or a systemd unit gets JSON lines, which `jq` and every log
 *    shipper can read without a parser written for this project.
 * 3. **Credentials never reach a log line.** Every emitted line passes through
 *    `scrubSecrets`, which blanks both key-ish URL parameters and the literal
 *    values of any credential-shaped environment variable. This is belt and
 *    braces over `redactUrl` — connector authors should not have to remember.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A nested scope, e.g. `connector` → `connector.fred`, inheriting bound fields. */
  child(scope: string, fields?: LogFields): Logger;
  /** True when a line at this level would be emitted — guard expensive field building. */
  enabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  /** Overrides `WD_LOG_LEVEL`. Mostly for tests. */
  level?: LogLevel;
  /** Overrides `WD_LOG_FORMAT`. */
  format?: 'text' | 'json';
  /** Where a line goes. Defaults to stderr plus `WD_LOG_FILE` when set. */
  sink?: (line: string) => void;
}

function envLevel(): LogLevel {
  const raw = (process.env.WD_LOG_LEVEL ?? '').toLowerCase();
  return raw in RANK ? (raw as LogLevel) : 'info';
}

function envFormat(): 'text' | 'json' {
  const raw = (process.env.WD_LOG_FORMAT ?? '').toLowerCase();
  if (raw === 'json' || raw === 'text') return raw;
  // No TTY means something is capturing this — a cron mail, a journal, a file.
  // Structured wins there; aligned colour wins in front of a person.
  return process.stderr.isTTY ? 'text' : 'json';
}

/** Env vars whose *values* must never appear in output, matched by name. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/**
 * Blank every credential we can recognise in an already-serialised line.
 *
 * Two passes, because the failure modes differ: an upstream URL carries the key
 * as a query parameter, while an error message from a library may quote the key
 * on its own ("invalid api_key: abcd…"). The second pass is what catches the
 * message we did not write ourselves.
 */
export function scrubSecrets(line: string): string {
  let out = line.replace(
    /\b(api_?key|apikey|access_?token|token|auth|key)=([^&"'\s,}]+)/gi,
    (_m, name: string) => `${name}=REDACTED`,
  );
  for (const [name, value] of Object.entries(process.env)) {
    // Short values produce false positives ("1", "true") and are not credentials.
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    if (out.includes(value)) out = out.split(value).join('REDACTED');
  }
  return out;
}

/** Normalise anything thrown into a loggable shape, with the stack kept separate. */
export function describeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'NonError', message: typeof err === 'string' ? err : JSON.stringify(err) };
}

/** The message alone — the common case at a call site that already has context. */
export function errorMessage(err: unknown): string {
  return describeError(err).message;
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
  const file = process.env.WD_LOG_FILE;
  if (!file) return;
  try {
    // Synchronous on purpose: a run that dies mid-append must still have the
    // line that explains why, and the volume here is a few hundred lines a day.
    appendFileSync(file, `${line}\n`);
  } catch {
    // A broken log file must never take the pipeline down with it.
  }
}

function fieldToText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return JSON.stringify(value);
}

const LEVEL_TAG: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: '\x1b[2mDEBUG\x1b[0m',
  info: '\x1b[36mINFO \x1b[0m',
  warn: '\x1b[33mWARN \x1b[0m',
  error: '\x1b[31mERROR\x1b[0m',
};

/**
 * Prepare fields for emission: unwrap Errors, redact URLs.
 *
 * Stacks are attached only on `error` lines. A warning with a full stack buries
 * the twenty other warnings around it, and a warning is by definition something
 * the run survived.
 */
function normaliseFields(fields: LogFields, level: LogLevel): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error || (k === 'err' && v !== null && typeof v === 'object')) {
      const e = describeError(v);
      out[k] = level === 'error' && e.stack ? e : { name: e.name, message: e.message };
    } else if (typeof v === 'string' && (k === 'url' || k.endsWith('Url'))) {
      out[k] = redactUrl(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(scope: string, opts: LoggerOptions = {}, bound: LogFields = {}): Logger {
  const sink = opts.sink ?? defaultSink;
  // Level and format are read per line rather than captured at construction:
  // module-level loggers are created before `loadEnv()` has run, so capturing
  // would make `WD_LOG_LEVEL` in `.env.local` silently do nothing.
  const levelOf = () => opts.level ?? envLevel();

  const emit = (level: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
    if (RANK[level] < RANK[levelOf()]) return;
    const all = normaliseFields({ ...bound, ...fields }, level);
    const ts = new Date().toISOString();

    let line: string;
    if ((opts.format ?? envFormat()) === 'json') {
      line = JSON.stringify({ ts, level, scope, msg, ...all });
    } else {
      const pairs = Object.entries(all).map(([k, v]) => `${k}=${fieldToText(v)}`).join(' ');
      line = `${ts.slice(11, 23)} ${LEVEL_TAG[level]} \x1b[2m${scope}\x1b[0m ${msg}${pairs ? `  ${pairs}` : ''}`;
    }
    sink(scrubSecrets(line));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (sub, f) => createLogger(`${scope}.${sub}`, opts, { ...bound, ...f }),
    enabled: (level) => RANK[level] >= RANK[levelOf()],
  };
}

/** The root logger. Prefer `log.child('<area>')` over creating parallel roots. */
export const log = createLogger('wd');
