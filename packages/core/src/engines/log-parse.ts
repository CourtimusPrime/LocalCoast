/**
 * Structured log parsing (spec: Observability). Detects pino/bunyan/winston
 * JSON lines in console/stdout text and extracts level, service, and fields so
 * they render as structured rows rather than raw objects.
 */

export interface ParsedStructuredLog {
  levelLabel?: string;
  serviceName?: string;
  message?: string;
  fields: Record<string, unknown>;
}

const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export function parseStructuredLog(text: string): ParsedStructuredLog | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  // Require at least one recognized structured-logger signal.
  const hasLevel = 'level' in obj;
  const hasTime = 'time' in obj || 'timestamp' in obj || 'ts' in obj || '@timestamp' in obj;
  const hasMessage = 'msg' in obj || 'message' in obj;
  if (!hasLevel && !(hasTime && hasMessage)) return null;

  let levelLabel: string | undefined;
  const level = obj.level;
  if (typeof level === 'number') levelLabel = PINO_LEVELS[level] ?? String(level);
  else if (typeof level === 'string') levelLabel = level.toLowerCase();

  const serviceName =
    (typeof obj.name === 'string' && obj.name) ||
    (typeof obj.service === 'string' && obj.service) ||
    (typeof obj.serviceName === 'string' && obj.serviceName) ||
    undefined;

  const message =
    (typeof obj.msg === 'string' && obj.msg) ||
    (typeof obj.message === 'string' && obj.message) ||
    undefined;

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (['level', 'time', 'timestamp', 'ts', '@timestamp', 'msg', 'message', 'name', 'service', 'serviceName', 'pid', 'hostname', 'v'].includes(k)) {
      continue;
    }
    fields[k] = v;
  }

  return { levelLabel, serviceName, message, fields };
}

const LEVEL_TO_CONSOLE: Record<string, 'debug' | 'log' | 'info' | 'warn' | 'error'> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  fatal: 'error',
};

export function levelToConsole(label: string | undefined): 'debug' | 'log' | 'info' | 'warn' | 'error' {
  return label ? (LEVEL_TO_CONSOLE[label] ?? 'log') : 'log';
}
