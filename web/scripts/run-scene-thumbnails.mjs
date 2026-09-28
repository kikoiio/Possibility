import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

process.chdir(resolve(dirname(new URL(import.meta.url).pathname), '../..'))
const bundle = resolve('web/scripts/.scene-thumbnails-bundle.mjs')
await build({
  entryPoints: ['web/scripts/generate-scene-thumbnails.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['sharp'],
  outfile: bundle,
})
try {
  await import(pathToFileURL(bundle).href)
} finally {
  await rm(bundle, { force: true })
}
