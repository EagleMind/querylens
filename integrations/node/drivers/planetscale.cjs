// PlanetScale's serverless driver (`@planetscale/database`, and Drizzle's planetscale-serverless
// driver). Every statement, from a `Client`, a `Connection` or a transaction, goes through
// `Connection.prototype.execute`, an HTTP call. Since version 2 the driver takes no bound
// values: they're written into the SQL, so it's scrubbed as MySQL before it's sent.
'use strict';

const { connectionIds, settle, startStatement } = require('./record.cjs');

/** Files holding the driver, in each of its builds. */
const BUILDS = ['dist/cjs/index.js', 'dist/index.js'];

/** Rows in an ExecutedQuery: rows read, or rows written. */
function planetscaleRows(res) {
  if (!res) return 0;
  return Array.isArray(res.rows) && res.rows.length > 0 ? res.rows.length : Number(res.rowsAffected) || 0;
}

/** Patch one build's exports. */
function patchPlanetScale(planetscale, monitor) {
  const Connection = planetscale && planetscale.Connection;
  const proto = Connection && Connection.prototype;
  if (typeof Connection !== 'function' || typeof proto.execute !== 'function' || proto.execute.__querylens) return planetscale;
  const execute = proto.execute;
  const connOf = connectionIds();
  proto.execute = function (query, args) {
    if (typeof query !== 'string') return execute.apply(this, arguments);
    // Values given anyway (1.x drivers formatted them in): kept, so the hash tells calls apart.
    const params = Array.isArray(args) ? args : args && typeof args === 'object' ? Object.values(args) : [];
    const finish = startStatement(monitor, { sql: query, params, dialect: 'mysql', conn: connOf(this) });
    return settle(execute.apply(this, arguments), finish, planetscaleRows);
  };
  proto.execute.__querylens = true;
  return planetscale;
}

module.exports = { patchPlanetScale, planetscaleRows, BUILDS };
