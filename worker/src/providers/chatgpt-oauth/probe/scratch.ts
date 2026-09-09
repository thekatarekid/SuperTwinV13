import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const ARTIFACT_ERROR = "REFUSED: Phase 0b scratch home violates the no-residual-artifacts proof";

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface ScratchBaseline {
  leafPresent: boolean;
  components: DirectoryIdentity[];
}

export interface ScratchHomeProof {
  readonly label: "no-residual-artifacts";
  readonly path: string;
  assertEmpty(): void;
}

function refuseArtifact(): never {
  throw new Error(ARTIFACT_ERROR);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return refuseArtifact();
  }
}

function isChild(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return Boolean(fromRoot) && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function trustedTempRoots(): { lexical: string; canonical: string } {
  const temporaryRootLexical = resolve(tmpdir());
  let temporaryRootCanonical: string;
  try {
    temporaryRootCanonical = realpathSync(tmpdir());
  } catch {
    return refuseArtifact();
  }
  return { lexical: temporaryRootLexical, canonical: temporaryRootCanonical };
}

function inspectDirectory(path: string, leaf: boolean): DirectoryIdentity {
  const stat = lstatIfPresent(path);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return refuseArtifact();
  const uid = process.getuid?.();
  if (uid !== undefined && Number(stat.uid) !== uid) return refuseArtifact();
  const permissions = Number(stat.mode) & 0o777;
  if (leaf ? permissions !== 0o700 : (permissions & 0o022) !== 0) return refuseArtifact();

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (Number(opened.dev) !== Number(stat.dev) || Number(opened.ino) !== Number(stat.ino) ||
        !opened.isDirectory()) return refuseArtifact();
    if (leaf && readdirSync(path).length !== 0) return refuseArtifact();
    const rechecked = lstatSync(path);
    if (rechecked.isSymbolicLink() || Number(rechecked.dev) !== Number(opened.dev) ||
        Number(rechecked.ino) !== Number(opened.ino)) return refuseArtifact();
    return { path, dev: Number(opened.dev), ino: Number(opened.ino) };
  } catch {
    return refuseArtifact();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        return refuseArtifact();
      }
    }
  }
}

function inspectScratchBaseline(path: string): ScratchBaseline {
  const roots = trustedTempRoots();
  const walkRoot = isChild(roots.lexical, path)
    ? roots.lexical
    : isChild(roots.canonical, path)
      ? roots.canonical
      : undefined;
  if (!walkRoot) throw new Error("REFUSED: probe home must be a child of the system temporary directory");
  const segments = relative(walkRoot, path).split(/[\\/]+/).filter(Boolean);
  const components: DirectoryIdentity[] = [];
  let cursor = walkRoot;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]!);
    if (!lstatIfPresent(cursor)) break;
    components.push(inspectDirectory(cursor, index === segments.length - 1));
  }
  const nearestExisting = components.at(-1)?.path ?? walkRoot;
  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync(nearestExisting);
  } catch {
    return refuseArtifact();
  }
  if (canonicalAncestor !== roots.canonical && !isChild(roots.canonical, canonicalAncestor)) {
    return refuseArtifact();
  }
  return { leafPresent: components.length === segments.length, components };
}

function sameBaseline(left: ScratchBaseline, right: ScratchBaseline): boolean {
  return left.leafPresent === right.leafPresent && left.components.length === right.components.length &&
    left.components.every((component, index) => {
      const other = right.components[index];
      return other?.path === component.path && other.dev === component.dev && other.ino === component.ino;
    });
}

export function beginScratchHomeProof(env: NodeJS.ProcessEnv = process.env): ScratchHomeProof {
  const configured = env.SUPERTWIN_HOME?.trim();
  if (!configured) throw new Error("REFUSED: SUPERTWIN_HOME must name an explicit scratch directory");
  const path = resolve(configured);
  if (path === resolve(homedir(), "SuperTwinV13")) {
    throw new Error("REFUSED: the Phase 0b probe cannot use the production home");
  }
  const initialBaseline = inspectScratchBaseline(path);
  return {
    label: "no-residual-artifacts",
    path,
    assertEmpty(): void {
      if (!sameBaseline(initialBaseline, inspectScratchBaseline(path))) return refuseArtifact();
    },
  };
}

/** Successor/live-run entry points require the disposable leaf to exist now. */
export function beginExistingScratchHomeProof(env: NodeJS.ProcessEnv = process.env): ScratchHomeProof {
  const proof = beginScratchHomeProof(env);
  const baseline = inspectScratchBaseline(proof.path);
  if (!baseline.leafPresent) return refuseArtifact();
  proof.assertEmpty();
  return proof;
}

export function assertEmptyScratchHome(env: NodeJS.ProcessEnv = process.env): string {
  return beginScratchHomeProof(env).path;
}

export async function enforceScratchHomeInvariant<T>(
  env: NodeJS.ProcessEnv,
  operation: () => Promise<T>,
): Promise<T> {
  const proof = beginScratchHomeProof({ ...env });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let artifactError: unknown;
  try {
    proof.assertEmpty();
  } catch (error) {
    artifactError = error;
  }
  if (artifactError !== undefined) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, artifactError],
        "Phase 0b operation failed and the no-residual-artifacts proof also failed",
        { cause: outcome.error },
      );
    }
    throw artifactError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
