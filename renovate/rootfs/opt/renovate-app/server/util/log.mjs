// Small leveled logger. The line shape follows bashio, so the app's log reads like any other app's.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LABELS = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function write(level, message, detail) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toTimeString().slice(0, 8);
  const suffix = detail instanceof Error ? ` (${detail.message})` : detail ? ` ${JSON.stringify(detail)}` : '';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`[${time}] ${LABELS[level]}: ${message}${suffix}\n`);
}

export const log = {
  debug: (message, detail) => write('debug', message, detail),
  info: (message, detail) => write('info', message, detail),
  warn: (message, detail) => write('warn', message, detail),
  error: (message, detail) => write('error', message, detail),
};
