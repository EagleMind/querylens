#!/usr/bin/env node
// Runs the prebuilt QueryLens binary for this platform. npm installs only the
// matching `querylens-cli-<platform>-<arch>` package (an optional dependency).
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const pkg = `querylens-cli-${process.platform}-${process.arch}`;
const exe = process.platform === 'win32' ? 'querylens.exe' : 'querylens';

let binary;
try {
  binary = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'bin', exe);
} catch {
  console.error(
    `querylens: no prebuilt binary for ${process.platform}-${process.arch} (package ${pkg} isn't installed).\n` +
      'If you installed with --no-optional or --omit=optional, reinstall without it. Other options:\n' +
      '  https://github.com/EagleMind/querylens#install',
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
// Ctrl+C reaches QueryLens directly (same terminal); it stops the command it runs and
// still writes the report. Stay alive until it's done.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => {});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => {
  console.error(`querylens: couldn't start ${binary}: ${err.message}`);
  process.exit(1);
});
