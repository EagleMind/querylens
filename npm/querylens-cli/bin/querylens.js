#!/usr/bin/env node
// Runs the prebuilt QueryLens binary for this platform. npm installs only the
// matching `querylens-cli-<platform>-<arch>` package (an optional dependency). When
// it's missing (blocked, or installed with --omit=optional), the binary is downloaded
// once from the GitHub release, checked against the release's SHA256SUMS, and cached.
'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const manifest = require('../package.json');
const REPO = 'EagleMind/querylens';
const target = `${process.platform}-${process.arch}`;
const windows = process.platform === 'win32';
const exe = windows ? 'querylens.exe' : 'querylens';
// The binaries' version; equal to the package's except for launcher-only releases.
const binaryVersion = (manifest.querylens && manifest.querylens.binaryVersion) || manifest.version;

function fromPackage() {
  try {
    return path.join(path.dirname(require.resolve(`querylens-cli-${target}/package.json`)), 'bin', exe);
  } catch {
    return null;
  }
}

function cacheDir() {
  const base = windows
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'querylens', binaryVersion, target);
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'querylens-cli' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url}: HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function download(dir) {
  const archive = `querylens-${target}${windows ? '.zip' : '.tar.gz'}`;
  const base = `https://github.com/${REPO}/releases/download/v${binaryVersion}`;
  process.stderr.write(`querylens: downloading the ${target} binary (v${binaryVersion}) from GitHub releases…\n`);
  const [data, sums] = await Promise.all([get(`${base}/${archive}`), get(`${base}/SHA256SUMS`)]);
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name && name.replace(/^\*/, '') === archive);
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (!expected || expected[0] !== actual) throw new Error(`checksum mismatch for ${archive}`);

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, archive);
  fs.writeFileSync(file, data);
  // tar ships with Windows 10+ (and reads .zip there), macOS and Linux.
  const tar = spawnSync('tar', ['-xf', file, '-C', dir], { stdio: 'inherit' });
  fs.rmSync(file, { force: true });
  if (tar.status !== 0) throw new Error(`couldn't extract ${archive}`);
  const binary = path.join(dir, exe);
  if (!windows) fs.chmodSync(binary, 0o755);
  return binary;
}

async function resolveBinary() {
  const packaged = fromPackage();
  if (packaged && fs.existsSync(packaged)) return packaged;
  const cached = path.join(cacheDir(), exe);
  if (fs.existsSync(cached)) return cached;
  return download(cacheDir());
}

function run(binary) {
  // A package packed without the executable bit would fail to spawn.
  if (!windows) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
    } catch {
      try {
        fs.chmodSync(binary, 0o755);
      } catch {}
    }
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
}

resolveBinary().then(run, (err) => {
  console.error(
    `querylens: no binary for ${target}: ${err.message}\n` +
      `Other ways to install: https://github.com/${REPO}#install`,
  );
  process.exit(1);
});
