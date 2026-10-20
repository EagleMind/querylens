// Packages that ship a CommonJS and an ES module build (Neon, PlanetScale, libSQL) load two
// copies of their classes: an app importing the package gets the ESM one, one requiring it
// the CommonJS one. Both are patched, by file, whichever the app uses.
'use strict';

const path = require('path');
const url = require('url');

/** The package's directory, from any file resolved inside it. */
function packageRoot(resolved, name) {
  const marker = path.join('node_modules', ...name.split('/'));
  const at = resolved.lastIndexOf(marker);
  return at === -1 ? null : resolved.slice(0, at + marker.length);
}

/**
 * Load each of `files` (relative to the package `root`) and pass its exports to `patch`.
 * ES modules are required where Node can (20.19+, 22.12+), which patches them before the
 * app's imports run; elsewhere they're imported, and patched shortly after. Files that
 * don't exist in this version of the package are skipped.
 */
function patchBuilds(root, files, patch) {
  for (const file of files) {
    const full = path.join(root, file);
    try {
      patch(require(full));
    } catch (e) {
      if (e && (e.code === 'ERR_REQUIRE_ESM' || e.code === 'ERR_REQUIRE_ASYNC_MODULE')) {
        import(url.pathToFileURL(full).href).then(
          (m) => {
            try {
              patch(m);
            } catch {}
          },
          () => {},
        );
      }
    }
  }
}

module.exports = { packageRoot, patchBuilds };
