// Recognizes the failures that have a simple fix and names them with a stable code, so the web interface
// can answer in the user's language with a concrete suggestion instead of a stack trace.
const RULES = [
  { code: 'out_of_memory', test: /heap out of memory|ERR_WORKER_OUT_OF_MEMORY|allocation failed/i },
  { code: 'authentication', test: /authentication failed|bad credentials|invalid token|token.*(expired|revoked)|401 unauthorized|requires authentication/i },
  { code: 'rate_limit', test: /rate.?limit|too many requests|\b429\b/i },
  { code: 'tls', test: /self.signed|unable to verify the first certificate|CERT_[A-Z_]+|certificate (has expired|is not trusted)/i },
  { code: 'network', test: /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|getaddrinfo/i },
  { code: 'disk_full', test: /ENOSPC|no space left/i },
];

/**
 * @param {{entries:object[], exitCode:number|null, signal:string|null, timedOut:boolean}} outcome
 * @returns {string|null} a code from the list above or "timeout" / "killed"; null when nothing is recognized
 */
export function diagnose({ entries, exitCode, signal, timedOut }) {
  if (timedOut) return 'timeout';
  const text = entries.filter((entry) => ['warn', 'error', 'fatal'].includes(entry.l))
    .map((entry) => `${entry.m} ${entry.x?.error ?? ''}`).join('\n');
  for (const { code, test } of RULES) if (test.test(text)) return code;
  // The kernel ends a process that uses too much memory with SIGKILL and no message at all.
  if (signal === 'SIGKILL') return 'out_of_memory';
  if (exitCode !== 0 && exitCode !== null) return 'failed';
  return null;
}
