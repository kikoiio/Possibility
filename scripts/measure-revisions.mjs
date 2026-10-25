import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { tsImport } from 'tsx/esm/api';

const DEFAULTS = { revisions: 12, depth: 4, entityGrowth: 8, samples: 5, pageSize: 5 };
const LIMITS = { revisions: 100, depth: 50, entityGrowth: 20, samples: 25, pageSize: 1000 };
const FLAGS = new Map([
  ['revisions', 'revisions'],
  ['depth', 'depth'],
  ['entity-growth', 'entityGrowth'],
  ['samples', 'samples'],
  ['page-size', 'pageSize'],
]);

let storeModule;

async function loadStore() {
  if (!storeModule) {
    storeModule = tsImport('../packages/engine/src/store/index.ts', import.meta.url);
  }
  return storeModule;
}

function validateOptions(options) {
  for (const [name, limit] of Object.entries(LIMITS)) {
    const value = options[name];
    const minimum = name === 'depth' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > limit) {
      throw new Error(`${name} must be an integer from ${minimum} to ${limit}.`);
    }
  }
  return options;
}

export function parseMeasureArgs(argv) {
  const options = { ...DEFAULTS };
  const provided = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument.slice(2) : argument.slice(2, separator);
    const key = FLAGS.get(flag);
    if (!key) throw new Error(`unknown option: --${flag}`);
    if (provided.has(key)) throw new Error(`--${flag} may only be provided once.`);

    const rawValue = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    if (rawValue === undefined || !/^\d+$/.test(rawValue)) {
      throw new Error(`--${flag} requires an integer value.`);
    }
    options[key] = Number(rawValue);
    provided.add(key);
  }
  return validateOptions(options);
}

function distribution(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
  return {
    count: ordered.length,
    min: ordered[0],
    p50: ordered.length % 2 === 0
      ? (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2
      : percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1),
    total: ordered.reduce((sum, value) => sum + value, 0),
  };
}

function makeLine({ id, name, parentLineId, forkRevisionId, headRevisionId, worldTimeMinutes }) {
  return {
    id,
    name,
    parentLineId,
    forkRevisionId,
    forkTimeMinutes: parentLineId === null ? null : worldTimeMinutes,
    headRevisionId,
    worldTimeMinutes,
    speed: 24,
    paused: false,
    plan: null,
    status: 'ready',
    error: null,
    retryAt: 0,
  };
}

function makeRevision({ id, parentId, worldTimeMinutes, kind, text, world }) {
  return {
    id,
    parentId,
    worldTimeMinutes,
    event: { id: `event-${id}`, kind, text, atMinutes: worldTimeMinutes },
    world: structuredClone(world),
  };
}

function assertIds(actualIds, expectedIds, description) {
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error(`${description}: pageLog returned unexpected revision IDs.`);
  }
}

export async function measureRevisions(input = DEFAULTS) {
  const options = validateOptions({ ...DEFAULTS, ...input });
  const tempRoot = resolve(process.cwd(), '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const runDirectory = await mkdtemp(join(tempRoot, 'measure-revisions-'));
  const databasePath = join(runDirectory, 'revisions.sqlite');
  let store;

  try {
    const { openStore } = await loadStore();
    store = await openStore(databasePath);

    const world = { entities: {} };
    const revisions = [];
    const historyIds = [];
    const linesByDepth = [];
    let entityIndex = 0;
    let worldTimeMinutes = 0;

    const addEntities = (description) => {
      for (let count = 0; count < options.entityGrowth; count += 1) {
        entityIndex += 1;
        const id = `entity-${String(entityIndex).padStart(6, '0')}`;
        world.entities[id] = { kind: 'place', name: id, description };
      }
    };

    const saveRevision = async (lineId, revision) => {
      await store.appendRevisions(lineId, [revision]);
      historyIds.push(revision.id);
      revisions.push({
        revisionId: revision.id,
        lineId,
        entityCount: Object.keys(revision.world.entities).length,
        worldJsonBytes: Buffer.byteLength(JSON.stringify(revision.world), 'utf8'),
        revisionJsonBytes: Buffer.byteLength(JSON.stringify(revision), 'utf8'),
      });
    };

    const rootLineId = 'line-root';
    const originId = 'revision-origin';
    await store.createLine(makeLine({
      id: rootLineId,
      name: 'Synthetic root',
      parentLineId: null,
      forkRevisionId: null,
      headRevisionId: originId,
      worldTimeMinutes,
    }));
    await saveRevision(rootLineId, makeRevision({
      id: originId,
      parentId: null,
      worldTimeMinutes,
      kind: 'origin',
      text: 'Synthetic origin',
      world,
    }));

    let parentLineId = rootLineId;
    let headRevisionId = originId;
    for (let index = 1; index <= options.revisions; index += 1) {
      addEntities(`Added at root revision ${index}.`);
      worldTimeMinutes += 60;
      const revision = makeRevision({
        id: `revision-root-${String(index).padStart(4, '0')}`,
        parentId: headRevisionId,
        worldTimeMinutes,
        kind: 'story',
        text: `Root revision ${index}`,
        world,
      });
      await saveRevision(rootLineId, revision);
      headRevisionId = revision.id;
    }
    linesByDepth.push({ depth: 0, lineId: rootLineId, revisionIds: [...historyIds] });

    for (let depth = 1; depth <= options.depth; depth += 1) {
      const inheritedHeadId = headRevisionId;
      const lineId = `line-fork-${String(depth).padStart(3, '0')}`;
      await store.createLine(makeLine({
        id: lineId,
        name: `Synthetic fork ${depth}`,
        parentLineId,
        forkRevisionId: inheritedHeadId,
        headRevisionId: inheritedHeadId,
        worldTimeMinutes,
      }));
      addEntities(`Added at fork depth ${depth}.`);
      worldTimeMinutes += 60;
      const revision = makeRevision({
        id: `revision-fork-${String(depth).padStart(3, '0')}`,
        parentId: inheritedHeadId,
        worldTimeMinutes,
        kind: 'story',
        text: `Fork revision ${depth}`,
        world,
      });
      await saveRevision(lineId, revision);
      headRevisionId = revision.id;
      parentLineId = lineId;
      linesByDepth.push({ depth, lineId, revisionIds: [...historyIds] });
    }

    const pageLogByDepth = [];
    for (const line of linesByDepth) {
      const expectedHistoryIds = [...line.revisionIds].reverse();
      const expectedFirstPageIds = expectedHistoryIds.slice(0, options.pageSize);
      const latencies = [];
      let firstPage;
      for (let sample = 0; sample < options.samples; sample += 1) {
        const startedAt = performance.now();
        const page = await store.pageLog(line.lineId, { limit: options.pageSize });
        latencies.push(performance.now() - startedAt);
        const actualIds = page.entries.map((entry) => entry.id);
        assertIds(actualIds, expectedFirstPageIds, `depth ${line.depth} first-page sample ${sample + 1}`);
        if (sample === 0) {
          firstPage = {
            expectedIds: expectedFirstPageIds,
            actualIds,
            expectedEntries: expectedFirstPageIds.length,
            actualEntries: actualIds.length,
            idsMatch: true,
          };
        }
      }

      const fullHistory = await store.pageLog(line.lineId, { limit: expectedHistoryIds.length });
      assertIds(fullHistory.entries.map((entry) => entry.id), expectedHistoryIds, `depth ${line.depth} full-history check`);
      if (fullHistory.nextBeforeRevisionId !== null) throw new Error(`depth ${line.depth}: full history was truncated.`);

      pageLogByDepth.push({
        depth: line.depth,
        lineId: line.lineId,
        firstPage,
        latencyMs: { ...distribution(latencies), samples: latencies },
        fullHistory: {
          expectedEntries: expectedHistoryIds.length,
          actualEntries: fullHistory.entries.length,
          idsMatch: true,
        },
      });
    }

    await store.close();
    const databaseFileBytes = (await stat(databasePath)).size;
    store = undefined;
    return {
      parameters: options,
      revisions,
      sizeDistribution: {
        worldJsonBytes: distribution(revisions.map((revision) => revision.worldJsonBytes)),
        revisionJsonBytes: distribution(revisions.map((revision) => revision.revisionJsonBytes)),
      },
      database: { fileBytes: databaseFileBytes, measuredAfterClose: true },
      pageLog: { pageSize: options.pageSize, byDepth: pageLogByDepth },
    };
  } finally {
    if (store) await store.close();
    await rm(runDirectory, { recursive: true, force: true });
  }
}

const USAGE = `Usage: node scripts/measure-revisions.mjs [options]
  --revisions N      Growing root revisions (default ${DEFAULTS.revisions})
  --depth N          Fork chain depth (default ${DEFAULTS.depth})
  --entity-growth N  Entities added per revision (default ${DEFAULTS.entityGrowth})
  --samples N        First-page timing samples per depth (default ${DEFAULTS.samples})
  --page-size N      Fixed pageLog first-page size (default ${DEFAULTS.pageSize})`;

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const report = await measureRevisions(parseMeasureArgs(argv));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`measure-revisions: ${message}\n`);
    process.exitCode = 1;
  }
}
