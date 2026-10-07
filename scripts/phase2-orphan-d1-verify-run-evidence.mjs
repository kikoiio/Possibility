import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN
const runId = '37569677434'
const artifactName = `phase2-cloudflare-temporary-${runId}-1`
if (!repo || !token) throw new Error('GitHub evidence inputs are incomplete')

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!response.ok) throw new Error(`GitHub evidence request failed (${response.status})`)
  return response
}

function zipEntries(zipPath) {
  return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean)
}

function zipText(zipPath, entry) {
  return execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
}

const temp = mkdtempSync(join(tmpdir(), 'phase2-orphan-evidence-'))
try {
  const jobsBody = await (await github(`/actions/runs/${runId}/jobs?per_page=100`)).json()
  const matchingJobs = (jobsBody.jobs ?? []).filter(job => job.name === 'Temporary run-scoped Worker and D1 acceptance')
  if (matchingJobs.length !== 1) throw new Error(`Expected one acceptance job in run ${runId}; found ${matchingJobs.length}`)
  const steps = matchingJobs[0].steps ?? []
  const preflight = steps.find(step => step.name === 'Verify the run-scoped names are unused')
  const create = steps.find(step => step.name === 'Create temporary D1')
  if (preflight?.conclusion !== 'success' || create?.conclusion !== 'failure') {
    throw new Error('Run job step conclusions do not match the recorded preflight/create sequence')
  }

  const logsPath = join(temp, 'run-logs.zip')
  const logsResponse = await github(`/actions/runs/${runId}/logs`)
  writeFileSync(logsPath, Buffer.from(await logsResponse.arrayBuffer()))
  const logs = zipEntries(logsPath)
    .filter(name => name.endsWith('.txt'))
    .map(name => zipText(logsPath, name))
    .join('\n')
  const absentPreflight = /"preexistingMatches"\s*:\s*\{\s*"worker"\s*:\s*false\s*,\s*"d1"\s*:\s*false\s*\}/s.test(logs)
  const createSucceeded = /PHASE2_TEMP_D1_CREATE_SUCCEEDED:\s*true/.test(logs)
  if (!absentPreflight || !createSucceeded) {
    throw new Error(`Required historical evidence missing (preflightAbsent=${absentPreflight}, createSucceeded=${createSucceeded})`)
  }

  const artifactsBody = await (await github(`/actions/runs/${runId}/artifacts?per_page=100`)).json()
  const artifacts = (artifactsBody.artifacts ?? []).filter(item => item.name === artifactName && !item.expired)
  if (artifacts.length !== 1) throw new Error(`Expected one unexpired cleanup artifact; found ${artifacts.length}`)
  const artifactPath = join(temp, 'cleanup-artifact.zip')
  const artifactResponse = await github(`/actions/artifacts/${artifacts[0].id}/zip`)
  writeFileSync(artifactPath, Buffer.from(await artifactResponse.arrayBuffer()))
  const cleanupEntry = zipEntries(artifactPath).find(name => name.endsWith('phase2-cloudflare-cleanup.json'))
  if (!cleanupEntry) throw new Error('Historical cleanup artifact has no cleanup JSON')
  const cleanup = JSON.parse(zipText(artifactPath, cleanupEntry))
  if (cleanup.worker !== 'not-created'
      || cleanup.d1 !== 'created-without-captured-id-not-deleted'
      || cleanup.ownershipGuardExit !== 0) {
    throw new Error('Historical cleanup artifact does not prove this exact orphan state')
  }

  process.stdout.write(`${JSON.stringify({
    result: 'verified',
    runId,
    preflight: 'worker=false,d1=false',
    d1CreateCommand: 'success marker present after Wrangler exited zero',
    cleanupArtifact: artifactName,
    cleanupState: cleanup.d1,
    ownershipGuardExit: cleanup.ownershipGuardExit,
  }, null, 2)}\n`)
  if (process.env.GITHUB_ENV) writeFileSync(process.env.GITHUB_ENV, 'PHASE2_ORPHAN_RUN_EVIDENCE_VERIFIED=true\n', { flag: 'a' })
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Historical orphan ownership evidence\n\n- Run: [${runId}](https://github.com/${repo}/actions/runs/${runId})\n- Preflight: Worker absent, D1 absent\n- Wrangler D1 create command: exited successfully; create-success marker found in run logs\n- Cleanup artifact: \`${artifactName}\`; recorded state \`${cleanup.d1}\`; ownership guard exit \`${cleanup.ownershipGuardExit}\`\n`,
      { flag: 'a' })
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
