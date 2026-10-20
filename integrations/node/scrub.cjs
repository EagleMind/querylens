// Removing values from SQL before it leaves the process (monitoring mode).
//
// Literals become `?` by the same rules QueryLens fingerprints statements with
// (querylens-core `normalize_sql`): quoted strings, numbers outside identifiers and
// booleans; `$1` / `?` placeholders, quoted identifiers, keywords and layout stay,
// comments go. Dialects differ in quoting: PostgreSQL quotes identifiers with "…" and
// doubles quotes inside strings; MySQL quotes identifiers with `…`, may quote strings
// with "…", and escapes with backslashes. A value is never mistaken for an identifier.
// So a scrubbed statement groups with the same statement sent in full. The values
// themselves are reduced to a hash, enough to tell an N+1 (different values each time)
// from a repeated query. Shared cases: test/scrub-cases.json (also run by the Rust tests).
'use strict';

const IDENT = /[\p{L}\p{N}_]/u;
const DIGIT = /[0-9]/;
const BOOLEAN = /^(true|false)$/i;
const MAX_SQL = 10_000;

/** End of a string literal opened at `i` with `quote`, honoring doubled quotes and (MySQL) backslashes. */
function stringEnd(sql, i, n, quote, backslashes) {
  let j = i + 1;
  while (j < n) {
    if (backslashes && sql[j] === '\\') {
      j += 2;
      continue;
    }
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      break;
    }
    j++;
  }
  return j;
}

/**
 * `{ sql, values }`: the statement with literals replaced by `?`, and the literals.
 * `dialect`: 'postgres' (default) or 'mysql'.
 */
function scrub(sql, dialect = 'postgres') {
  const mysql = dialect === 'mysql';
  const values = [];
  let out = '';
  const n = Math.min(sql.length, MAX_SQL);
  const prevIdent = () => out.length > 0 && IDENT.test(out[out.length - 1]);
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || (c === '"' && mysql)) {
      const j = stringEnd(sql, i, n, c, mysql);
      values.push(sql.slice(i, j + 1));
      out += '?';
      i = j + 1;
    } else if (c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && sql[j] !== c) j++;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      let j = i + 2;
      while (j + 1 < n && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
      i = j + 2;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '$' && DIGIT.test(sql[i + 1] || '')) {
      let j = i + 1;
      while (j < n && DIGIT.test(sql[j])) j++;
      out += sql.slice(i, j);
      i = j;
    } else if (DIGIT.test(c) && !prevIdent()) {
      let j = i;
      while (j < n && (DIGIT.test(sql[j]) || sql[j] === '.')) j++;
      values.push(sql.slice(i, j));
      out += '?';
      i = j;
    } else if (IDENT.test(c) && !prevIdent()) {
      let j = i;
      while (j < n && IDENT.test(sql[j])) j++;
      const word = sql.slice(i, j);
      if (BOOLEAN.test(word)) {
        values.push(word);
        out += '?';
      } else {
        out += word;
      }
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return { sql: out, values };
}

/** FNV-1a (32 bit) of the values, as 8 hex digits. Not reversible to the values. */
function valueHash(literals, params) {
  const text = JSON.stringify([literals, params || []]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Error messages can quote the offending value (`invalid input syntax for type integer: "abc"`). */
function scrubError(text) {
  if (!text) return text;
  return text
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/:\s*"[^"]*"/g, ': "?"')
    .replace(/\(([^()]*)\)=\(([^()]*)\)/g, '($1)=(?)');
}

module.exports = { scrub, valueHash, scrubError };
