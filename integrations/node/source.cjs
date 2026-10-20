// Source context (opt-in: `sourceContext: true` or QUERYLENS_SOURCE_CONTEXT=1): the lines of
// application code around each line that ran a reported query, so the backend can show them
// and write fixes against the real code. Each line of code is read once per process, in the
// background, from files inside the project only. Secrets that look like secrets (keys,
// passwords, tokens, credentials in URLs) are masked before anything leaves the process.
'use strict';

const fs = require('fs');
const path = require('path');

/** Lines sent before and after the origin's line, and characters kept per line. */
const BEFORE = 10;
const AFTER = 10;
const MAX_LINE = 300;
/** Files larger than this aren't read (generated or bundled code). */
const MAX_FILE = 1024 * 1024;
/** Files kept in memory while their lines are being read. */
const FILE_CACHE = 50;

const MASK = '***';
const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth(?:orization)?|credential|private[_-]?key|access[_-]?key)[\w-]*['"]?\s*[:=]\s*)(['"`])[^'"`\n]{4,}?\2/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/'"`@]+:)[^\s@'"`]+@/gi;
/** A quoted run of 32+ key-like characters with letters and digits: an API key or token. */
const KEY_LITERAL = /(['"`])(?=[A-Za-z0-9+/_=.-]*\d)(?=[A-Za-z0-9+/_=.-]*[A-Za-z])[A-Za-z0-9+/_=.-]{32,}\1/g;

/** `line` with anything that looks like a secret masked. */
function redact(line) {
  return line
    .replace(SECRET_ASSIGNMENT, (_, lead, quote) => `${lead}${quote}${MASK}${quote}`)
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(KEY_LITERAL, (_, quote) => `${quote}${MASK}${quote}`);
}

/** `src/a.js:42` → { file, line } when it's a relative path inside the project. */
function parseOrigin(origin) {
  const m = /^(.+):(\d+)$/.exec(origin || '');
  if (!m) return null;
  const file = m[1];
  const line = Number(m[2]);
  if (line < 1 || path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) return null;
  return { file, line };
}

/**
 * Reads snippets relative to `root` (the directory origins are relative to).
 * `readFile(absolutePath) → Promise<string>` replaces the file system (tests).
 */
function createSourceReader({ root = process.cwd(), readFile } = {}) {
  const read =
    readFile ||
    (async (file) => {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size > MAX_FILE) return null;
      return fs.promises.readFile(file, 'utf8');
    });
  const files = new Map();

  async function lines(file) {
    if (files.has(file)) return files.get(file);
    let text = null;
    try {
      text = await read(path.join(root, file));
    } catch {}
    const result = typeof text === 'string' && text.length <= MAX_FILE ? text.split(/\r?\n/) : null;
    if (files.size >= FILE_CACHE) files.delete(files.keys().next().value);
    files.set(file, result);
    return result;
  }

  /** The source item for `origin`, or `null` when it can't be read. Never rejects. */
  async function snippet(origin) {
    try {
      const at = parseOrigin(origin);
      if (!at) return null;
      const all = await lines(at.file);
      if (!all || at.line > all.length) return null;
      const first = Math.max(1, at.line - BEFORE);
      const last = Math.min(all.length, at.line + AFTER);
      const picked = all.slice(first - 1, last).map((l) => redact(l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l));
      return { type: 'source', origin, firstLine: first, lines: picked };
    } catch {
      return null;
    }
  }

  return { snippet, clear: () => files.clear() };
}

module.exports = { createSourceReader, redact, parseOrigin };
