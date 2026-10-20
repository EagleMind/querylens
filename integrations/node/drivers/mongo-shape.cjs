// A MongoDB command as one canonical, value-free text, the way querylens-core reads it
// (crates/core/src/capture/mongo.rs), and the values taken out of it:
//
//   db.order_items.find({"orderId": ?}).sort({"createdAt": -1}).limit(?)   the driver
//   OrderItem.find({"orderId": ?})                                           through a Mongoose model
//
// Operators, field names, field paths ("$total"), sort and projection directions and
// $lookup's collection and field names are structure, and stay; every other value is `?`.
// `$in: [a, b, c]` is `$in: [?]` whatever its length. Pure.
'use strict';

/** Commands that read or write documents; the rest (handshakes, sessions, indexes) aren't recorded. */
const COMMANDS = new Set(['find', 'aggregate', 'count', 'distinct', 'insert', 'update', 'delete', 'findAndModify']);
const MAX_DEPTH = 8;
const MAX_KEYS = 50;
const MAX_VALUES = 100;
const MAX_TEXT = 4000;
const PLACEHOLDER = Symbol('?');
/** Operators whose array holds values: one `?` for all of them. */
const LIST_OPERATORS = new Set(['$in', '$nin', '$all']);
/** Operators whose argument is structure, not a value. */
const STRUCTURAL_OPERATORS = new Set(['$exists', '$type', '$size']);
/** Logical operators: their argument is filters. */
const LOGICAL = new Set(['$and', '$or', '$nor']);
/** $lookup's arguments that name collections and fields. */
const LOOKUP_NAMES = new Set(['from', 'localField', 'foreignField', 'as']);

/** A value as text, for `sendValues` and the value hash. */
function valueText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (typeof v.toHexString === 'function') return v.toHexString();
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v._bsontype && typeof v.toString === 'function') return v.toString();
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v._bsontype || v instanceof Date || v instanceof RegExp) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const isOperatorObject = (v) => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));

class Shaper {
  constructor() {
    this.values = [];
  }

  value(v) {
    if (this.values.length < MAX_VALUES) this.values.push(valueText(v));
    return PLACEHOLDER;
  }

  keys(obj) {
    return Object.keys(obj).slice(0, MAX_KEYS);
  }

  /** A query filter: field names and operators stay, values go. */
  filter(f, depth = 0) {
    if (!isPlainObject(f) || depth > MAX_DEPTH) return f === undefined ? {} : this.value(f);
    const out = {};
    for (const k of this.keys(f)) {
      const v = f[k];
      if (LOGICAL.has(k) && Array.isArray(v)) out[k] = v.map((part) => this.filter(part, depth + 1));
      else if (k === '$expr') out[k] = this.expression(v, depth + 1);
      else if (k.startsWith('$')) out[k] = this.value(v);
      else out[k] = isOperatorObject(v) ? this.operators(v, depth + 1) : this.value(v);
    }
    return out;
  }

  /** `{ $gt: 5, $in: [1, 2] }` on a field. */
  operators(ops, depth) {
    const out = {};
    for (const k of this.keys(ops)) {
      const v = ops[k];
      if (LIST_OPERATORS.has(k) && Array.isArray(v)) {
        v.forEach((x) => this.value(x));
        out[k] = [PLACEHOLDER];
      } else if (STRUCTURAL_OPERATORS.has(k)) out[k] = v;
      else if (k === '$elemMatch' || k === '$not') out[k] = isOperatorObject(v) ? this.operators(v, depth + 1) : this.filter(v, depth + 1);
      else out[k] = this.value(v);
    }
    return out;
  }

  /** An aggregation expression or spec: field paths, keys and 0 / 1 / -1 stay. */
  expression(e, depth = 0) {
    if (depth > MAX_DEPTH) return this.value(e);
    if (typeof e === 'string') return e.startsWith('$') ? e : this.value(e);
    if (typeof e === 'number') return e === 0 || e === 1 || e === -1 ? e : this.value(e);
    if (typeof e === 'boolean') return e;
    if (Array.isArray(e)) return e.map((x) => this.expression(x, depth + 1));
    if (!isPlainObject(e)) return this.value(e);
    const out = {};
    for (const k of this.keys(e)) out[k] = this.expression(e[k], depth + 1);
    return out;
  }

  /** One pipeline stage. */
  stage(s, depth = 0) {
    if (!isPlainObject(s)) return this.value(s);
    const out = {};
    for (const k of this.keys(s)) {
      const v = s[k];
      if (k === '$match') out[k] = this.filter(v, depth + 1);
      else if (k === '$limit' || k === '$skip' || k === '$sample') out[k] = this.value(v);
      else if (k === '$lookup' && isPlainObject(v)) {
        const lookup = {};
        for (const lk of this.keys(v)) {
          if (LOOKUP_NAMES.has(lk) && typeof v[lk] === 'string') lookup[lk] = v[lk];
          else if (lk === 'pipeline' && Array.isArray(v[lk])) lookup[lk] = v[lk].map((x) => this.stage(x, depth + 1));
          else lookup[lk] = this.expression(v[lk], depth + 1);
        }
        out[k] = lookup;
      } else if (k === '$facet' && isPlainObject(v)) {
        out[k] = Object.fromEntries(this.keys(v).map((name) => [name, (Array.isArray(v[name]) ? v[name] : []).map((x) => this.stage(x, depth + 1))]));
      } else out[k] = this.expression(v, depth + 1);
    }
    return out;
  }

  /** Inserted documents: all values, no structure (the text says `[?]`). */
  documents(docs) {
    for (const d of (Array.isArray(docs) ? docs : []).slice(0, 3)) this.collect(d, 0);
    return [PLACEHOLDER];
  }

  collect(v, depth) {
    if (this.values.length >= MAX_VALUES) return;
    if (isPlainObject(v) && depth < MAX_DEPTH) this.keys(v).forEach((k) => this.collect(v[k], depth + 1));
    else if (Array.isArray(v) && depth < MAX_DEPTH) v.slice(0, MAX_KEYS).forEach((x) => this.collect(x, depth + 1));
    else this.value(v);
  }

  /** An update document (`$set`…), a replacement, or a pipeline. */
  update(u) {
    if (Array.isArray(u)) return u.map((s) => this.stage(s));
    if (!isPlainObject(u)) return this.value(u);
    if (!isOperatorObject(u)) {
      this.collect(u, 0);
      return PLACEHOLDER;
    }
    const out = {};
    for (const op of this.keys(u)) {
      const fields = u[op];
      if (!isPlainObject(fields)) {
        out[op] = this.value(fields);
        continue;
      }
      out[op] = {};
      for (const f of this.keys(fields)) out[op][f] = op === '$unset' ? fields[f] : this.value(fields[f]);
    }
    return out;
  }
}

/** Relaxed JSON with `?` for removed values. */
function write(v) {
  if (v === PLACEHOLDER) return '?';
  if (Array.isArray(v)) return `[${v.map(write).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).map((k) => `${JSON.stringify(k)}: ${write(v[k])}`).join(', ')}}`;
  return v === undefined ? 'null' : JSON.stringify(v);
}

/**
 * `{ text, values }` for a command document, or `null` when it isn't a recorded command.
 * `model`: the Mongoose model it was issued through, written instead of `db.<collection>`.
 */
function shapeCommand(name, command, model) {
  if (!COMMANDS.has(name) || !command || typeof command[name] !== 'string') return null;
  const target = model || `db.${command[name]}`;
  const s = new Shaper();
  let args;
  const modifiers = [];
  switch (name) {
    case 'find':
      args = [s.filter(command.filter)];
      if (isPlainObject(command.sort)) modifiers.push(['sort', [s.expression(command.sort)]]);
      if (command.skip) modifiers.push(['skip', [s.value(command.skip)]]);
      if (command.limit) modifiers.push(['limit', [s.value(command.limit)]]);
      break;
    case 'aggregate':
      args = [(Array.isArray(command.pipeline) ? command.pipeline : []).map((st) => s.stage(st))];
      break;
    case 'count':
      args = [s.filter(command.query)];
      break;
    case 'distinct':
      args = [String(command.key), s.filter(command.query)];
      break;
    case 'insert':
      args = [s.documents(command.documents)];
      break;
    case 'update': {
      const first = (Array.isArray(command.updates) && command.updates[0]) || {};
      args = [s.filter(first.q), s.update(first.u)];
      break;
    }
    case 'delete': {
      const first = (Array.isArray(command.deletes) && command.deletes[0]) || {};
      args = [s.filter(first.q)];
      break;
    }
    case 'findAndModify':
      args = [s.filter(command.query), command.remove ? { remove: true } : s.update(command.update)];
      break;
  }
  let text = `${target}.${name}(${args.map(write).join(', ')})${modifiers.map(([m, a]) => `.${m}(${a.map(write).join(', ')})`).join('')}`;
  // Too long to keep: still one shape per command, so it groups and is evaluated.
  if (text.length > MAX_TEXT) text = `${target}.${name}()`;
  return { text, values: s.values };
}

/** Documents a command's reply returned or wrote. */
function replyRows(name, reply) {
  if (!reply) return 0;
  if (reply.cursor) return (reply.cursor.firstBatch || reply.cursor.nextBatch || []).length;
  if (name === 'distinct') return Array.isArray(reply.values) ? reply.values.length : 0;
  if (name === 'count') return 1;
  if (name === 'findAndModify') return reply.value ? 1 : 0;
  return typeof reply.n === 'number' ? reply.n : 0;
}

module.exports = { shapeCommand, replyRows, valueText, COMMANDS };
