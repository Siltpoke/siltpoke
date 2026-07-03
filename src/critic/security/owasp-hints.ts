// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
export interface OwaspHint {
  owasp_id: string;
  category: string;
  hint: string;
  matched_file: string;
}

interface HintRule {
  pattern: RegExp;
  owasp_id: string;
  category: string;
  hint: string;
}

const RULES: ReadonlyArray<HintRule> = [
  {
    pattern: /\bauth|login|logout|signin|session|jwt|password|credential\b/i,
    owasp_id: "A07",
    category: "Identification & Authentication Failures",
    hint: "Check: password complexity, brute-force throttle, secure session storage, MFA option.",
  },
  {
    pattern: /upload|file-handler|fileupload|multipart/i,
    owasp_id: "A03",
    category: "Injection",
    hint: "Check: path traversal (`../`), MIME type validation, max file size, virus scan stub.",
  },
  {
    pattern: /\bapi\/|routes?\/|controllers?\/|handlers?\//i,
    owasp_id: "A01",
    category: "Broken Access Control",
    hint: "Check: authz on every endpoint, no IDOR (user can't access /api/users/<otherId>), rate limit.",
  },
  {
    pattern: /\bquery\b|\bsql\b|\bdb\b|database|prisma|sequelize|knex|drizzle/i,
    owasp_id: "A03",
    category: "Injection (SQL)",
    hint: "Check: parameterized queries, no string interpolation of user input into SQL.",
  },
  {
    pattern: /template|render|view|html|jinja|ejs|handlebars/i,
    owasp_id: "A03",
    category: "Injection (Template/XSS)",
    hint: "Check: escape user input on render; CSP header; no eval/dangerouslySetInnerHTML.",
  },
  {
    pattern: /env|process\.env|\.env|secret|key|token/i,
    owasp_id: "A02",
    category: "Cryptographic Failures",
    hint: "Check: secrets in env vars not source; TLS verified; no hardcoded keys.",
  },
];

export function collectOwaspHints(changedFiles: string[]): OwaspHint[] {
  const hints: OwaspHint[] = [];
  const seen = new Set<string>();

  for (const file of changedFiles) {
    for (const r of RULES) {
      if (r.pattern.test(file)) {
        const key = `${file}::${r.owasp_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push({
          owasp_id: r.owasp_id,
          category: r.category,
          hint: r.hint,
          matched_file: file,
        });
      }
    }
  }

  return hints;
}
