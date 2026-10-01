// Redaction for every text field that leaves the server. Conservative: false positives are fine.

const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted-key]'],
  [/\b(sk|pk|rk)-(ant-|proj-|live-|test-)?[A-Za-z0-9_\-]{12,}/g, '[redacted]'],
  [/\b(glpat|glptt|gldt|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs]|npm|hf|AIza)[-_][A-Za-z0-9_\-]{12,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{8,}/gi, '$1 [redacted]'],
  [/\b((?:access|refresh|auth|api|private|client|session)?[_-]?(?:token|key|secret|password|passwd|pwd|apikey))(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1$2[redacted]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'], // creds in URLs
  [/\b[0-9a-fA-F]{32,}\b/g, '[redacted-hex]'],
  // long base64/base64url blobs with mixed character classes
  [/[A-Za-z0-9+_\-]{32,}={0,2}/g, (m: string) => (/[0-9]/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? '[redacted]' : m)] as any,
  [/[A-Za-z0-9+/]{40,}={1,2}/g, '[redacted]'],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of RULES) out = out.replace(re, rep as any);
  return out;
}

// Keys whose values are identifiers/colors, not free text. Everything else is redacted.
const ID_KEYS = new Set(['id', 'from', 'to', 'parent', 'team', 'lead', 'hue', 'role', 'status', 'kind', 'source', 'agentId']);

export function redactDeep<T>(v: T, key = ''): T {
  if (typeof v === 'string') return (ID_KEYS.has(key) ? v : redact(v)) as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, key)) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = redactDeep(x, k);
    return o as T;
  }
  return v;
}
