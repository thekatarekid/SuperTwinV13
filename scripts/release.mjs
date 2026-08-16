#!/usr/bin/env node
// ===========================================================================
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
// overwritten: if a .dmg for that version is already there — whatever its
// architecture suffix — the script refuses to run before touching a single
// file. The .dmg is gitignored and shipped as a GitHub Release asset rather
// than committed: ~700 MB per version adds up fast in history. RELEASES.md is
// the committed manifest of what exists, and rows are only ever added or
// filled in, never rewritten and never removed.
//
// The interesting parts are exported as pure functions so scripts/release.test.mjs
// can drive them without building a 700 MB installer; the CLI body below only
// runs when this file is the entry point.
// ===========================================================================

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_NAME = 'SuperTwinV11'

// package-lock.json is bumped structurally (below) rather than by regex: it
// carries unrelated dependency versions that a regex would happily corrupt.
export const VERSION_FILES = [
  'package.json',
  'worker/package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
]

export const MANIFEST_FILE = 'RELEASES.md'

export const MANIFEST_HEADER = `# Releases

Every build ever cut. The \`.dmg\` files live in \`releases/\` on the build
machine and are attached to the matching GitHub Release rather than committed.
Nothing here is ever removed.

| Version | Size | SHA-256 |
|---|---|---|
`

const TABLE_HEADER = '| Version | Size | SHA-256 |'
const PENDING = 'pending'

export const SEMVER = /^\d+\.\d+\.\d+$/

// ---------------------------------------------------------------------------
// version arithmetic
// ---------------------------------------------------------------------------

/** Next version from `from` given the CLI flags in `args`. Pure. */
export function nextVersion(from, args = []) {
  if (!SEMVER.test(from ?? '')) throw new Error(`current version is not X.Y.Z: ${from}`)

  const setIdx = args.indexOf('--set')
  if (setIdx !== -1) {
    const v = args[setIdx + 1]
    if (!SEMVER.test(v ?? '')) throw new Error(`--set needs a X.Y.Z version, got ${v}`)
    return v
  }

  const bumps = ['--major', '--minor', '--patch'].filter((f) => args.includes(f))
  if (bumps.length > 1) throw new Error(`pick one of ${bumps.join(' ')}, not several`)

  const [major, minor, patch] = from.split('.').map(Number)
  if (args.includes('--major')) return `${major + 1}.0.0`
  if (args.includes('--minor')) return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// ---------------------------------------------------------------------------
// .dmg naming
// ---------------------------------------------------------------------------

// Tauri names the installer <product>_<version>_<arch>.dmg — aarch64 for an
// Apple-silicon build, x64 for Intel, universal for a fat one. The arch is not
// ours to predict, so we match on the version instead of guessing a filename.
const DMG_RE = new RegExp(`^${APP_NAME}_(\\d+\\.\\d+\\.\\d+)_([A-Za-z0-9_.-]+)\\.dmg$`)

/** The version a .dmg filename claims, or null if it is not one of ours. */
export function dmgVersion(name) {
  const m = DMG_RE.exec(name)
  return m ? m[1] : null
}

/** Every archived .dmg in `dir` for `version`. Missing dir means none. */
export function archivedDmgs(dir, version) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => dmgVersion(f) === version)
    .sort()
}

/** Directories `tauri build` may have dropped a .dmg in, host or cross build. */
export function bundleDirs(root) {
  const targetDir = join(root, 'src-tauri', 'target')
  const dirs = [join(targetDir, 'release', 'bundle', 'dmg')]
  if (existsSync(targetDir)) {
    for (const entry of readdirSync(targetDir)) {
      if (entry === 'release' || entry === 'debug') continue
      dirs.push(join(targetDir, entry, 'release', 'bundle', 'dmg'))
    }
  }
  return dirs
}

/** Absolute paths of freshly built .dmgs for `version`, newest first. */
export function builtDmgs(root, version) {
  const found = []
  for (const dir of bundleDirs(root)) {
    for (const name of archivedDmgs(dir, version)) found.push(join(dir, name))
  }
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

// ---------------------------------------------------------------------------
// version files
// ---------------------------------------------------------------------------

/**
 * Rewrite exactly one `"version": "x.y.z"` / `version = "x.y.z"` line — the
 * first in the file, which in each of these files is the package's own. Pure:
 * takes and returns text so a caller can validate every file before writing any.
 */
export function bumpSource(text, relPath, version) {
  if (!SEMVER.test(version ?? '')) throw new Error(`not a X.Y.Z version: ${version}`)
  const json = relPath.endsWith('.json')
  const re = json ? /("version"\s*:\s*")\d+\.\d+\.\d+(")/ : /^(version\s*=\s*")\d+\.\d+\.\d+(")/m
  if (!re.test(text)) throw new Error(`no version field found in ${relPath}`)
  return text.replace(re, `$1${version}$2`)
}

/**
 * package-lock.json carries the root version three times (top level, the ""
 * package, and each workspace) beside hundreds of dependency versions that
 * must not move. Structural edit, not a regex — and a lockfile left stale
 * makes `npm ci` in CI disagree with package.json.
 */
export function bumpLockfile(text, version, workspaces = []) {
  if (!SEMVER.test(version ?? '')) throw new Error(`not a X.Y.Z version: ${version}`)
  const lock = JSON.parse(text)
  if (lock.version) lock.version = version
  for (const key of ['', ...workspaces]) {
    if (lock.packages?.[key]?.version) lock.packages[key].version = version
  }
  return `${JSON.stringify(lock, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// RELEASES.md
// ---------------------------------------------------------------------------

function rowRe(version) {
  return new RegExp(`^\\|\\s*${version.replace(/\./g, '\\.')}\\s*\\|.*$`, 'm')
}

/** Versions already in the manifest, mapped to `{ pending }`. */
export function recordedVersions(text) {
  const out = new Map()
  for (const line of (text ?? '').split('\n')) {
    const m = /^\|\s*(\d+\.\d+\.\d+)\s*\|([^|]*)\|([^|]*)\|/.exec(line)
    if (m) out.set(m[1], { pending: m[3].trim() === PENDING })
  }
  return out
}

/**
 * Add `version` to the manifest, or fill in the row a `--no-build` bump left
 * pending. Never rewrites a row that already carries a digest, never drops a
 * prior row, and always keeps the table header.
 */
export function recordRelease(text, version, entry = null) {
  if (!SEMVER.test(version ?? '')) throw new Error(`not a X.Y.Z version: ${version}`)
  const base = (text ?? '').includes(TABLE_HEADER) ? text : MANIFEST_HEADER
  const row = entry
    ? `| ${version} | ${entry.size} | \`${entry.sha256}\` |`
    : `| ${version} | — | ${PENDING} |`

  const existing = recordedVersions(base).get(version)
  if (existing) {
    if (!entry) return base // already listed; a second --no-build changes nothing
    if (!existing.pending) {
      throw new Error(
        `${MANIFEST_FILE} already records ${version} with a digest — refusing to rewrite it`,
      )
    }
    return base.replace(rowRe(version), row)
  }
  return `${base.trimEnd()}\n${row}\n`
}

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

// Chunked rather than readFileSync: the .dmg is ~700 MB since the whisper
// model started shipping inside it, and there is no reason to hold all of it.
export function sha256File(path) {
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

export function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

// ---------------------------------------------------------------------------
// the release itself
// ---------------------------------------------------------------------------

function die(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

/**
 * Everything that must hold before a single byte is written. Throws with a
 * maintainer-readable reason; the caller turns that into exit 1.
 */
export function preflight(root, version) {
  const dupes = archivedDmgs(join(root, 'releases'), version)
  if (dupes.length) {
    throw new Error(
      `releases/${dupes[0]} already exists — every version ships exactly once. ` +
        'Pick another version with --set.',
    )
  }

  const manifestPath = join(root, MANIFEST_FILE)
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : MANIFEST_HEADER
  const recorded = recordedVersions(manifest).get(version)
  if (recorded && !recorded.pending) {
    throw new Error(
      `${MANIFEST_FILE} already records ${version} as shipped. Pick another version with --set.`,
    )
  }

  // Every version file must be bumpable before any of them is written, so a
  // failure halfway down cannot leave the tree half-bumped.
  const planned = []
  for (const rel of VERSION_FILES) {
    const abs = join(root, rel)
    if (!existsSync(abs)) throw new Error(`missing version file ${rel}`)
    planned.push([abs, rel, bumpSource(readFileSync(abs, 'utf8'), rel, version)])
  }
  return { planned, manifestPath, manifest }
}

export function applyBump(root, version, planned) {
  for (const [abs, rel, text] of planned) {
    writeFileSync(abs, text)
    console.log(`  ${rel} -> ${version}`)
  }

  const lockPath = join(root, 'package-lock.json')
  if (existsSync(lockPath)) {
    const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? []
    writeFileSync(lockPath, bumpLockfile(readFileSync(lockPath, 'utf8'), version, workspaces))
    console.log(`  package-lock.json -> ${version}`)
  }
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const args = argv.slice(2)
  const noBuild = args.includes('--no-build')
  const releasesDir = join(root, 'releases')

  const from = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  let to
  try {
    to = nextVersion(from, args)
  } catch (err) {
    die(err.message)
  }

  let plan
  try {
    plan = preflight(root, to)
  } catch (err) {
    die(err.message)
  }

  console.log(`version ${from} -> ${to}`)
  applyBump(root, to, plan.planned)

  if (noBuild) {
    // Record the version as pending so the manifest lists every version ever
    // cut, including one bumped now and built on a release runner later.
    writeFileSync(plan.manifestPath, recordRelease(plan.manifest, to, null))
    console.log(`--no-build: version files bumped, ${MANIFEST_FILE} row pending, nothing built`)
    return
  }

  console.log('building…')
  execFileSync('npm', ['run', 'build:app'], { cwd: root, stdio: 'inherit' })

  const built = builtDmgs(root, to)[0]
  if (!built) {
    console.error(`release: build finished but no ${APP_NAME}_${to}_*.dmg landed in`)
    for (const dir of bundleDirs(root)) console.error(`  ${dir}`)
    console.error('(the .app may still be fine — see bundle/macos/)')
    process.exit(1)
  }

  const dmgName = built.split('/').pop()
  const archived = join(releasesDir, dmgName)
  mkdirSync(releasesDir, { recursive: true })
  try {
    // COPYFILE_EXCL, not a bare copy: the build takes long enough that the
    // existsSync check at preflight is not a guarantee any more.
    copyFileSync(built, archived, constants.COPYFILE_EXCL)
  } catch (err) {
    if (err.code === 'EEXIST') die(`releases/${dmgName} appeared during the build — refusing to overwrite it`)
    throw err
  }
  console.log(`archived releases/${dmgName}`)

  const sha = sha256File(archived)
  const size = humanSize(statSync(archived).size)

  // RELEASES.md is committed; the .dmg files themselves are not.
  const manifest = existsSync(plan.manifestPath)
    ? readFileSync(plan.manifestPath, 'utf8')
    : plan.manifest
  writeFileSync(plan.manifestPath, recordRelease(manifest, to, { size, sha256: sha }))
  console.log(`recorded in ${MANIFEST_FILE} — ${size}, sha256 ${sha.slice(0, 16)}…`)

  if (args.includes('--publish')) {
    try {
      publish(root, to, archived, sha)
    } catch (err) {
      die(err.message)
    }
  }
}

// Publishing is a separate, deliberately dumb step: create the release, fail if
// the tag is already there. See main() above.
export function publish(root, version, dmgPath, sha) {
  const tag = `v${version}`
  let existing = ''
  try {
    existing = execFileSync('gh', ['release', 'view', tag, '--json', 'tagName'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    // `gh release view` exits non-zero when the release does not exist, which
    // is the case we want.
  }
  if (existing.trim()) {
    throw new Error(`a GitHub Release ${tag} already exists — refusing to replace its assets`)
  }
  console.log(`publishing ${tag} to GitHub Releases…`)
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      dmgPath,
      '--title',
      `${APP_NAME} ${version}`,
      '--notes',
      `macOS (Apple silicon) installer.\n\nsha256 \`${sha}\``,
    ],
    { cwd: root, stdio: 'inherit' },
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
}
