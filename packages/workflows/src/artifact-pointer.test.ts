import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  ARTIFACT_POINTER_TYPE,
  validateArtifactPointers,
  type ArtifactPointer,
} from './artifact-pointer';
import type { WorkflowRun } from './schemas';

/**
 * #2453 — an artifact pointer is a run id plus a relative path, and the engine proves it
 * addresses a real file inside a run this run may see BEFORE the value crosses a boundary.
 */
describe('artifact pointers (#2453)', () => {
  let home: string;
  let outputRoot: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  /** Every run the fake lookup can resolve, by id. */
  let runs: Map<string, WorkflowRun>;
  let lookups: string[];

  const lookup = async (runId: string): Promise<WorkflowRun | null> => {
    lookups.push(runId);
    return runs.get(runId) ?? null;
  };

  function makeRun(id: string, overrides?: Partial<WorkflowRun>): WorkflowRun {
    const run: WorkflowRun = {
      id,
      workflow_name: 'wf',
      conversation_id: 'conv',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'running',
      outcome: null,
      user_message: 'msg',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: null,
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: outputRoot,
      ...overrides,
    };
    runs.set(id, run);
    return run;
  }

  /** This run's artifacts directory, laid out exactly as the executor writes it. */
  function artifactsDir(runId: string): string {
    return join(outputRoot, 'artifacts', 'runs', runId);
  }

  async function writeArtifact(runId: string, relPath: string, body = 'contents'): Promise<void> {
    const full = join(artifactsDir(runId), relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
  }

  const pointer = (runId: string, path: string): ArtifactPointer => ({
    type: ARTIFACT_POINTER_TYPE,
    run_id: runId,
    path,
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'artifact-pointer-'));
    process.env.ARCHON_HOME = home;
    outputRoot = join(home, 'workspaces', '_cwd', 'proj');
    runs = new Map();
    lookups = [];
  });

  afterEach(async () => {
    await removeTempTree(home);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  describe('which runs a pointer may address', () => {
    it('accepts a pointer at the current run and never reads a row for it', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', 'plan.md');

      const result = await validateArtifactPointers(
        { ready: true, plan: pointer('run-self', 'plan.md') },
        current,
        lookup
      );

      expect(result).toBeNull();
      // The current run is already in hand — reaching for the store would be a round trip
      // that can only return what the caller passed in.
      expect(lookups).toEqual([]);
    });

    it('accepts a pointer at an ancestor run', async () => {
      makeRun('run-parent');
      const child = makeRun('run-child', { parent_run_id: 'run-parent' });
      await writeArtifact('run-parent', 'plan.md');

      expect(
        await validateArtifactPointers(pointer('run-parent', 'plan.md'), child, lookup)
      ).toBeNull();
    });

    it('accepts a pointer at a descendant run', async () => {
      const parent = makeRun('run-parent');
      makeRun('run-child', { parent_run_id: 'run-parent' });
      await writeArtifact('run-child', 'report.md');

      expect(
        await validateArtifactPointers(pointer('run-child', 'report.md'), parent, lookup)
      ).toBeNull();
    });

    it('accepts a pointer at a run this one explicitly adopted', async () => {
      makeRun('run-prior');
      const adopting = makeRun('run-next', { adopted_from_run_id: 'run-prior' });
      await writeArtifact('run-prior', 'plan.md');

      expect(
        await validateArtifactPointers(pointer('run-prior', 'plan.md'), adopting, lookup)
      ).toBeNull();
    });

    it('rejects a pointer at an unrelated run whose file exists', async () => {
      const current = makeRun('run-a');
      makeRun('run-b');
      await writeArtifact('run-b', 'secrets.md');

      const result = await validateArtifactPointers(
        pointer('run-b', 'secrets.md'),
        current,
        lookup
      );

      expect(result).toContain("names a run outside this run's tree");
      expect(result).toContain("run 'run-b'");
    });

    it('rejects a sibling fan-out child of the same parent', async () => {
      makeRun('run-parent');
      const first = makeRun('run-child-0', { parent_run_id: 'run-parent' });
      makeRun('run-child-1', { parent_run_id: 'run-parent' });
      await writeArtifact('run-child-1', 'plan.md');

      expect(
        await validateArtifactPointers(pointer('run-child-1', 'plan.md'), first, lookup)
      ).toContain("outside this run's tree");
    });

    it('rejects a pointer at a run that does not exist', async () => {
      const current = makeRun('run-a');

      expect(await validateArtifactPointers(pointer('run-gone', 'plan.md'), current, lookup)).toBe(
        "the artifact pointer at $ (run 'run-gone', path 'plan.md') names a run that does not exist"
      );
    });

    it('rejects a pointer at a run whose artifacts location was never recorded', async () => {
      makeRun('run-parent', { output_root: null });
      const child = makeRun('run-child', { parent_run_id: 'run-parent' });

      expect(
        await validateArtifactPointers(pointer('run-parent', 'plan.md'), child, lookup)
      ).toContain('output_root is null');
    });

    it('rejects a pointer at a run whose recorded location is outside the Archon home', async () => {
      makeRun('run-parent', { output_root: join(tmpdir(), 'somewhere-else') });
      const child = makeRun('run-child', { parent_run_id: 'run-parent' });

      expect(
        await validateArtifactPointers(pointer('run-parent', 'plan.md'), child, lookup)
      ).toContain('outside the Archon home directory');
    });
  });

  describe('which paths a pointer may name', () => {
    it('rejects an absolute path', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', 'plan.md');

      expect(
        await validateArtifactPointers(
          pointer('run-self', join(artifactsDir('run-self'), 'plan.md')),
          current,
          lookup
        )
      ).toContain('must use a path relative');
    });

    it('rejects a traversal segment', async () => {
      const current = makeRun('run-self');

      expect(
        await validateArtifactPointers(pointer('run-self', '../../plan.md'), current, lookup)
      ).toContain("may not contain '..' path segments");
    });

    it('rejects a NUL byte', async () => {
      const current = makeRun('run-self');

      expect(
        await validateArtifactPointers(pointer('run-self', 'plan.md\0.txt'), current, lookup)
      ).toContain('contains a NUL byte');
    });

    it('rejects a file that does not exist', async () => {
      const current = makeRun('run-self');
      await mkdir(artifactsDir('run-self'), { recursive: true });

      expect(
        await validateArtifactPointers(pointer('run-self', 'nope.md'), current, lookup)
      ).toContain('refers to a file that does not exist');
    });

    it('rejects a directory', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', join('review', 'report.md'));

      expect(
        await validateArtifactPointers(pointer('run-self', 'review'), current, lookup)
      ).toContain('does not refer to a regular file');
    });

    it('accepts a nested relative path', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', join('review', 'report.md'));

      expect(
        await validateArtifactPointers(pointer('run-self', 'review/report.md'), current, lookup)
      ).toBeNull();
    });

    it.skipIf(process.platform === 'win32')(
      'rejects a symlink whose target escapes the run artifacts directory',
      async () => {
        const current = makeRun('run-self');
        const outside = join(home, 'outside.md');
        await writeFile(outside, 'not an artifact');
        await mkdir(artifactsDir('run-self'), { recursive: true });
        await symlink(outside, join(artifactsDir('run-self'), 'escape.md'));

        expect(
          await validateArtifactPointers(pointer('run-self', 'escape.md'), current, lookup)
        ).toContain("resolves outside that run's artifacts directory");
      }
    );

    it.skipIf(process.platform === 'win32')(
      'accepts a symlink whose target stays inside the run artifacts directory',
      async () => {
        const current = makeRun('run-self');
        await writeArtifact('run-self', 'plan.md');
        await symlink(
          join(artifactsDir('run-self'), 'plan.md'),
          join(artifactsDir('run-self'), 'latest.md')
        );

        expect(
          await validateArtifactPointers(pointer('run-self', 'latest.md'), current, lookup)
        ).toBeNull();
      }
    );
  });

  describe('where pointers are found in a value', () => {
    it('validates pointers nested in arrays and objects', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', 'plan.md');

      const value = {
        units: [
          { name: 'a', plan: pointer('run-self', 'plan.md') },
          { name: 'b', plan: pointer('run-self', 'missing.md') },
        ],
      };

      expect(await validateArtifactPointers(value, current, lookup)).toContain(
        'the artifact pointer at $.units[1].plan'
      );
    });

    it('rejects an object that claims the reserved tag but is not a pointer', async () => {
      const current = makeRun('run-self');

      const result = await validateArtifactPointers(
        { plan: { type: ARTIFACT_POINTER_TYPE, run_id: 'run-self' } },
        current,
        lookup
      );

      expect(result).toContain('$.plan is tagged');
      expect(result).toContain('An artifact pointer is');
    });

    it('tolerates extra keys beside the three engine-owned fields', async () => {
      const current = makeRun('run-self');
      await writeArtifact('run-self', 'plan.md');

      expect(
        await validateArtifactPointers(
          { plan: { ...pointer('run-self', 'plan.md'), label: 'the plan' } },
          current,
          lookup
        )
      ).toBeNull();
    });

    it('does no I/O at all for a value carrying no pointer', async () => {
      const current = makeRun('run-self', { output_root: null });

      expect(
        await validateArtifactPointers(
          { ready: true, units: ['a', 'b'], nested: { type: 'plan', note: null } },
          current,
          lookup
        )
      ).toBeNull();
      expect(lookups).toEqual([]);
    });

    it('reads one row per named run however many pointers name it', async () => {
      const parent = makeRun('run-parent');
      makeRun('run-child', { parent_run_id: 'run-parent' });
      await writeArtifact('run-child', 'a.md');
      await writeArtifact('run-child', 'b.md');

      expect(
        await validateArtifactPointers(
          [pointer('run-child', 'a.md'), pointer('run-child', 'b.md')],
          parent,
          lookup
        )
      ).toBeNull();
      expect(lookups.filter(id => id === 'run-child')).toEqual(['run-child']);
    });
  });
});
