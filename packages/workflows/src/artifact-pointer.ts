/**
 * Artifact pointers (#2453) — the one reserved shape a workflow result may use to point
 * at a file instead of carrying it.
 *
 * A workflow that produces something large (a plan, a report, a diff) already writes it
 * under `$ARTIFACTS_DIR` and returns a small structured summary. Until now the file's
 * location was a naming convention: nothing tied the summary to the file, and nothing
 * checked that the location a result named was one the run may actually address.
 *
 * A pointer is an ordinary `JsonValue` carrying a reserved discriminator:
 *
 * ```json
 * { "type": "archon_artifact", "run_id": "01J…", "path": "plan.md" }
 * ```
 *
 * The value stays a run id plus a RELATIVE path everywhere — in events, in APIs, and on a
 * resumed run. The engine never expands it into an absolute path and never loads the file:
 * it only proves, before the value crosses a boundary, that the pointer addresses a real
 * regular file inside a run this run is allowed to see. Consumers resolve it themselves;
 * `GET /api/artifacts/:runId/<path>` takes exactly these two fields and repeats the same
 * containment checks server-side.
 */
import { stat, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import { getRunArtifactsDirForRoot, isInsideArchonHome } from '@archon/paths';
import type { WorkflowRun } from './schemas';

/** Reserved `type` discriminator. An object carrying it MUST be a valid pointer. */
export const ARTIFACT_POINTER_TYPE = 'archon_artifact';

/**
 * The pointer shape. Unknown sibling keys are tolerated (an author may label a pointer for
 * their own downstream code); the three engine-owned fields are not optional.
 */
export const artifactPointerSchema = z.object({
  type: z.literal(ARTIFACT_POINTER_TYPE),
  run_id: z.string().min(1),
  path: z.string().min(1),
});

export type ArtifactPointer = z.infer<typeof artifactPointerSchema>;

/**
 * The narrow store read this validation needs: one run row by id. Deliberately not
 * `IWorkflowStore` — reachability is a two-link walk over rows, nothing more.
 */
export type RunLookup = (runId: string) => Promise<WorkflowRun | null>;

/**
 * Safety cap on the run-link walk, mirroring `getRunAncestry`'s. The cycle guards prevent
 * a cyclic run tree, but a hand-edited database must never hang a node.
 */
const MAX_RUN_LINK_HOPS = 32;

/** One tagged object found inside a value, with the JSON path that located it. */
interface TaggedCandidate {
  at: string;
  value: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect every object tagged with the reserved discriminator, at any depth. Cheap and
 * allocation-free for the overwhelmingly common case of a value with no pointers at all,
 * which is what lets every producer call this without paying for a store or disk read.
 */
function collectTagged(value: unknown, at: string, found: TaggedCandidate[]): void {
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      collectTagged(element, `${at}[${String(index)}]`, found);
    });
    return;
  }
  if (!isPlainObject(value)) return;
  if (value.type === ARTIFACT_POINTER_TYPE) {
    found.push({ at, value });
    // A pointer's own fields are strings; nothing nested to walk.
    return;
  }
  for (const [key, child] of Object.entries(value)) collectTagged(child, `${at}.${key}`, found);
}

/** Every run id reachable UPWARD from `start` through parent and adoption links. */
async function upwardClosure(start: WorkflowRun, lookup: RunLookup): Promise<Set<string>> {
  const seen = new Set<string>([start.id]);
  const queue: WorkflowRun[] = [start];
  for (let hops = 0; queue.length > 0 && hops < MAX_RUN_LINK_HOPS; hops++) {
    const run = queue.shift();
    if (run === undefined) break;
    for (const linked of [run.parent_run_id, run.adopted_from_run_id]) {
      if (linked === null || seen.has(linked)) continue;
      seen.add(linked);
      const next = await lookup(linked);
      // A deleted parent (ON DELETE SET NULL) or a pruned adopted run ends that branch;
      // the id stays in the set because the link itself is evidence of the relation.
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

/**
 * Why one pointer was rejected, phrased to complete a sentence beginning with the failing
 * node's identity: `Node 'plan': <reason>.`
 */
async function checkPointer(
  candidate: TaggedCandidate,
  currentRun: WorkflowRun,
  lookup: RunLookup,
  currentClosure: () => Promise<Set<string>>
): Promise<string | null> {
  const parsed = artifactPointerSchema.safeParse(candidate.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return (
      `the value at ${candidate.at} is tagged '${ARTIFACT_POINTER_TYPE}' but is not a valid artifact pointer (${issues}). ` +
      `An artifact pointer is { "type": "${ARTIFACT_POINTER_TYPE}", "run_id": <run id>, "path": <path relative to that run's artifacts directory> }`
    );
  }
  const pointer = parsed.data;
  const where = `the artifact pointer at ${candidate.at} (run '${pointer.run_id}', path '${pointer.path}')`;

  // Path shape first: it is decided by the value alone, so a malformed path is reported
  // the same way whether or not the run it names happens to exist.
  if (pointer.path.includes('\0')) return `${where} contains a NUL byte in its path`;
  if (isAbsolute(pointer.path) || pointer.path.startsWith('/') || pointer.path.startsWith('\\')) {
    return `${where} must use a path relative to that run's artifacts directory, not an absolute one`;
  }
  if (pointer.path.split(/[\\/]/).includes('..')) {
    return `${where} may not contain '..' path segments`;
  }

  const pointerRun =
    pointer.run_id === currentRun.id ? currentRun : await lookup(pointer.run_id).catch(() => null);
  if (pointerRun === null) return `${where} names a run that does not exist`;

  if (pointer.run_id !== currentRun.id) {
    const reachable =
      (await currentClosure()).has(pointer.run_id) ||
      (await upwardClosure(pointerRun, lookup)).has(currentRun.id);
    if (!reachable) {
      return (
        `${where} names a run outside this run's tree — a result may only point at artifacts ` +
        'of its own run, an ancestor, a descendant, or a run it explicitly adopted'
      );
    }
  }

  // The artifacts location comes from the pointed-at run's own persisted `output_root`, so
  // a renamed codebase keeps resolving (#1192) and a run that never recorded one is simply
  // unaddressable — the same limit `$ADOPTED_RUN_DIR` has.
  const outputRoot = pointerRun.output_root;
  if (outputRoot === null || outputRoot.trim() === '') {
    return `${where} names a run whose artifacts location was never recorded (output_root is null), so the file cannot be addressed`;
  }
  if (!isInsideArchonHome(outputRoot)) {
    return `${where} names a run whose recorded artifacts location is outside the Archon home directory`;
  }

  const root = normalize(getRunArtifactsDirForRoot(outputRoot, pointer.run_id));
  const full = normalize(join(root, pointer.path));
  if (!full.startsWith(root + sep)) {
    return `${where} resolves outside that run's artifacts directory`;
  }

  // Physical resolution as well as lexical: a symlink inside the artifacts directory
  // pointing anywhere else is exactly the escape the '..' rule blocks in text form.
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return `${where} names a run whose artifacts directory does not exist`;
  }
  let realFull: string;
  try {
    realFull = await realpath(full);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return `${where} refers to a file that does not exist under that run's artifacts directory`;
    }
    return `${where} could not be resolved: ${(error as Error).message}`;
  }
  if (!realFull.startsWith(realRoot + sep)) {
    return `${where} resolves outside that run's artifacts directory`;
  }
  const stats = await stat(realFull).catch(() => null);
  if (!stats?.isFile()) {
    return `${where} does not refer to a regular file`;
  }
  return null;
}

/**
 * Validate every artifact pointer inside one logical value, immediately before that value
 * is persisted and becomes readable downstream.
 *
 * Returns `null` when the value carries no pointer or every pointer is valid, and the
 * rejection reason otherwise. A reason, not a throw: the producers that call this each have
 * their own failure convention (a thrown contract error, a `failResult`, a `failLoopNode`),
 * and the message is written to complete `Node '<id>': <reason>.`
 */
export async function validateArtifactPointers(
  value: unknown,
  currentRun: WorkflowRun,
  lookup: RunLookup
): Promise<string | null> {
  const found: TaggedCandidate[] = [];
  collectTagged(value, '$', found);
  if (found.length === 0) return null;

  // One row is read at most once per value, however many pointers name it.
  const runCache = new Map<string, Promise<WorkflowRun | null>>();
  const cachedLookup: RunLookup = runId => {
    const hit = runCache.get(runId);
    if (hit !== undefined) return hit;
    const pending = lookup(runId).catch(() => null);
    runCache.set(runId, pending);
    return pending;
  };
  let closure: Promise<Set<string>> | undefined;
  const currentClosure = (): Promise<Set<string>> =>
    (closure ??= upwardClosure(currentRun, cachedLookup));

  for (const candidate of found) {
    const rejection = await checkPointer(candidate, currentRun, cachedLookup, currentClosure);
    if (rejection !== null) return rejection;
  }
  return null;
}
