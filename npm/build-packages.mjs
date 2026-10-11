// Assemble the npm packages from compiled binaries.
//
//   node npm/build-packages.mjs <version> <binaries-dir> [--require-all]
//
// <binaries-dir> holds `querylens-<platform>-<arch>[.exe]` files (as the release
// workflow names them). Output goes to npm/dist/: `querylens-cli` plus one
// `querylens-cli-<platform>-<arch>` per binary found, and the SDK, `querylens-node`.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

const [version, binaries, flag] = process.argv.slice(2)
if (!version || !binaries) {
  console.error('usage: node npm/build-packages.mjs <version> <binaries-dir> [--require-all]')
  process.exit(2)
}
// A launcher-only release reuses already published binaries: QUERYLENS_BINARY_VERSION=0.1.0.
const binaryVersion = process.env.QUERYLENS_BINARY_VERSION || version
const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'dist')
rmSync(dist, { recursive: true, force: true })

const template = readFileSync(join(here, 'platform-package.json'), 'utf8')
const built = []
for (const target of PLATFORMS) {
  const [platform, arch] = target.split('-')
  const exe = platform === 'win32' ? 'querylens.exe' : 'querylens'
  const source = join(binaries, `querylens-${target}${platform === 'win32' ? '.exe' : ''}`)
  if (!existsSync(source)) {
    if (flag === '--require-all') throw new Error(`missing binary ${source}`)
    continue
  }
  const dir = join(dist, `querylens-cli-${target}`)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const manifest = JSON.parse(template.replaceAll('PLATFORM', platform).replaceAll('ARCH', arch))
  manifest.version = binaryVersion
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  copyFileSync(source, join(dir, 'bin', exe))
  chmodSync(join(dir, 'bin', exe), 0o755)
  built.push(target)
}

const main = join(dist, 'querylens-cli')
mkdirSync(join(main, 'bin'), { recursive: true })
const manifest = JSON.parse(readFileSync(join(here, 'querylens-cli', 'package.json'), 'utf8'))
manifest.version = version
manifest.querylens = { binaryVersion }
for (const dep of Object.keys(manifest.optionalDependencies)) manifest.optionalDependencies[dep] = binaryVersion
writeFileSync(join(main, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
copyFileSync(join(here, 'querylens-cli', 'bin', 'querylens.js'), join(main, 'bin', 'querylens.js'))
chmodSync(join(main, 'bin', 'querylens.js'), 0o755)
copyFileSync(join(here, '..', 'README.md'), join(main, 'README.md'))
copyFileSync(join(here, '..', 'LICENSE'), join(main, 'LICENSE'))

// The SDK (integrations/node), same version.
const sdkSource = join(here, '..', 'integrations', 'node')
const sdk = join(dist, 'querylens-node')
mkdirSync(sdk, { recursive: true })
const sdkManifest = JSON.parse(readFileSync(join(sdkSource, 'package.json'), 'utf8'))
sdkManifest.version = version
delete sdkManifest.scripts
writeFileSync(join(sdk, 'package.json'), JSON.stringify(sdkManifest, null, 2) + '\n')
for (const file of sdkManifest.files) copyFileSync(join(sdkSource, file), join(sdk, file))
copyFileSync(join(here, '..', 'LICENSE'), join(sdk, 'LICENSE'))

console.log(`querylens-cli and querylens-node ${version}; binaries for: ${built.join(', ') || 'none'}`)
