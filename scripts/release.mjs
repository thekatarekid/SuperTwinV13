#!/usr/bin/env node
// Version-bumped, archived release build.
//
//   npm run release              # patch bump  0.1.0 -> 0.1.1
//   npm run release -- --minor   # 0.1.0 -> 0.2.0
//   npm run release -- --major   # 0.1.0 -> 1.0.0
//   npm run release -- --set 0.4.2
//   npm run release -- --no-build   # bump the version files only
//   npm run release -- --publish    # also upload the .dmg to GitHub Releases
//
// Every .dmg lands in releases/ under its own version and is never
// overwritten: if the file is already there the script refuses to run.
// The .dmg is gitignored and shipped as a GitHub Release asset rather than
// committed — ~700 MB per version adds up fast in history. RELEASES.md is the
// committed manifest of what exists.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releasesDir = join(root, 'releases')

const args = process.argv.slice(2)
const noBuild = args.includes('--no-build')

function currentVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

function nextVersion(from) {
  const setIdx = args.indexOf('--set')
  if (setIdx !== -1) {
    const v = args[setIdx + 1]
    if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) throw new Error(`--set needs a X.Y.Z version, got ${v}`)
    return v
  }
  const [major, minor, patch] = from.split('.').map(Number)
  if (args.includes('--major')) return `${major + 1}.0.0`
  if (args.includes('--minor')) return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// Rewrites exactly one `"version": "x.y.z"` / `version = "x.y.z"` line, the
// first one in the file, which in all four of these files is the package's own.
function bumpFile(relPath, version) {
  const abs = join(root, relPath)
  const before = readFileSync(abs, 'utf8')
  const json = relPath.endsWith('.json')
  const re = json ? /("version"\s*:\s*")\d+\.\d+\.\d+(")/ : /^(version\s*=\s*")\d+\.\d+\.\d+(")/m
  if (!re.test(before)) throw new Error(`no version field found in ${relPath}`)
  const after = before.replace(re, `$1${version}$2`)
  writeFileSync(abs, after)
  console.log(`  ${relPath} -> ${version}`)
}

const from = currentVersion()
const to = nextVersion(from)
const dmgName = `SuperTwinV11_${to}_aarch64.dmg`
const archived = join(releasesDir, dmgName)

if (existsSync(archived)) {
  console.error(`refusing to overwrite releases/${dmgName} — pick another version with --set`)
  process.exit(1)
}

console.log(`version ${from} -> ${to}`)
for (const f of ['package.json', 'worker/package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml']) {
  bumpFile(f, to)
}

if (noBuild) {
  console.log('--no-build: version files bumped, nothing built')
  process.exit(0)
}

console.log('building…')
execFileSync('npm', ['run', 'build:app'], { cwd: root, stdio: 'inherit' })

const bundleDir = join(root, 'src-tauri/target/release/bundle/dmg')
const built = existsSync(bundleDir)
  ? readdirSync(bundleDir).find((f) => f === dmgName)
  : undefined

if (!built) {
  console.error(`build finished but ${dmgName} is not in src-tauri/target/release/bundle/dmg`)
  console.error('(the .app may still be fine — see bundle/macos/)')
  process.exit(1)
}

mkdirSync(releasesDir, { recursive: true })
copyFileSync(join(bundleDir, built), archived)
console.log(`archived releases/${dmgName}`)

// Chunked rather than readFileSync: the .dmg is ~700 MB since the whisper
// model started shipping inside it, and there is no reason to hold all of it.
function sha256File(path) {
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    let read
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

const sha = sha256File(archived)
const mb = (statSync(archived).size / 1024 / 1024).toFixed(0)

// RELEASES.md is committed; the .dmg files themselves are not.
const manifest = join(root, 'RELEASES.md')
const header = '# Releases\n\nEvery build ever cut. The `.dmg` files live in `releases/` on the build\nmachine and are attached to the matching GitHub Release rather than committed.\nNothing here is ever removed.\n\n| Version | Size | SHA-256 |\n|---|---|---|\n'
const existing = existsSync(manifest) ? readFileSync(manifest, 'utf8') : header
writeFileSync(manifest, existing.trimEnd() + `\n| ${to} | ${mb} MB | \`${sha}\` |\n`)
console.log(`recorded in RELEASES.md — sha256 ${sha.slice(0, 16)}…`)

if (args.includes('--publish')) {
  console.log(`publishing v${to} to GitHub Releases…`)
  execFileSync('gh', ['release', 'create', `v${to}`, archived,
    '--title', `SuperTwinV11 ${to}`,
    '--notes', `macOS (Apple silicon) installer.\n\nsha256 \`${sha}\``,
  ], { cwd: root, stdio: 'inherit' })
}
