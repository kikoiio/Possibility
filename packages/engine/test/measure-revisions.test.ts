import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scriptPath = fileURLToPath(new URL('../../../scripts/measure-revisions.mjs', import.meta.url));

async function runCli(args: string[]): Promise<string> {
  const result = await execFileAsync(process.execPath, [scriptPath, ...args], { cwd: projectRoot });
  return String(result.stdout);
}

describe('revision measurement CLI', () => {
  it('runs independently and reports snapshot sizes and fixed-page latency by fork depth', async () => {
    const stdout = await runCli([
      '--revisions', '3',
      '--depth', '3',
      '--entity-growth', '2',
      '--samples', '2',
      '--page-size', '2',
    ]);
    const report: unknown = JSON.parse(stdout);

    expect(report).toMatchObject({
      parameters: { revisions: 3, depth: 3, entityGrowth: 2, samples: 2, pageSize: 2 },
      revisions: [
        { entityCount: 0, worldJsonBytes: expect.any(Number), revisionJsonBytes: expect.any(Number) },
        { entityCount: 2, worldJsonBytes: expect.any(Number), revisionJsonBytes: expect.any(Number) },
        { entityCount: 4, worldJsonBytes: expect.any(Number), revisionJsonBytes: expect.any(Number) },
        { entityCount: 6, worldJsonBytes: expect.any(Number), revisionJsonBytes: expect.any(Number) },
        { entityCount: 8, worldJsonBytes: expect.any(Number), revisionJsonBytes: expect.any(Number) },
        { entityCount: 10, worldJsonBytes: expect.any(Number), revisionJsonBytes: expect.any(Number) },
        { entityCount: 12, worldJsonBytes: expect.any(Number), revisionJsonBytes: expect.any(Number) },
      ],
      sizeDistribution: {
        worldJsonBytes: { count: 7, min: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number), max: expect.any(Number) },
        revisionJsonBytes: { count: 7, min: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number), max: expect.any(Number) },
      },
      database: { fileBytes: expect.any(Number), measuredAfterClose: true },
      pageLog: {
        pageSize: 2,
        byDepth: [
          {
            depth: 0,
            firstPage: { expectedIds: ['revision-root-0003', 'revision-root-0002'], actualIds: ['revision-root-0003', 'revision-root-0002'], expectedEntries: 2, actualEntries: 2, idsMatch: true },
            latencyMs: { count: 2, min: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number), max: expect.any(Number), samples: [expect.any(Number), expect.any(Number)] },
            fullHistory: { expectedEntries: 4, actualEntries: 4, idsMatch: true },
          },
          {
            depth: 1,
            firstPage: { expectedIds: ['revision-fork-001', 'revision-root-0003'], actualIds: ['revision-fork-001', 'revision-root-0003'], expectedEntries: 2, actualEntries: 2, idsMatch: true },
            latencyMs: { count: 2, samples: [expect.any(Number), expect.any(Number)] },
            fullHistory: { expectedEntries: 5, actualEntries: 5, idsMatch: true },
          },
          {
            depth: 2,
            firstPage: { expectedIds: ['revision-fork-002', 'revision-fork-001'], actualIds: ['revision-fork-002', 'revision-fork-001'], expectedEntries: 2, actualEntries: 2, idsMatch: true },
            latencyMs: { count: 2, samples: [expect.any(Number), expect.any(Number)] },
            fullHistory: { expectedEntries: 6, actualEntries: 6, idsMatch: true },
          },
          {
            depth: 3,
            firstPage: { expectedIds: ['revision-fork-003', 'revision-fork-002'], actualIds: ['revision-fork-003', 'revision-fork-002'], expectedEntries: 2, actualEntries: 2, idsMatch: true },
            latencyMs: { count: 2, samples: [expect.any(Number), expect.any(Number)] },
            fullHistory: { expectedEntries: 7, actualEntries: 7, idsMatch: true },
          },
        ],
      },
    });
  });

  it('rejects invalid CLI arguments', async () => {
    await expect(runCli(['--revisions', '0'])).rejects.toThrow();
    await expect(runCli(['--unknown', '1'])).rejects.toThrow();
  });
});
