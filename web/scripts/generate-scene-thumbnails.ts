import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { contemporaryTheme } from '../../packages/scene-contract/src/themes/contemporary'

const root = process.cwd()
const assetsRoot = join(root, 'web/public/scene-assets/contemporary')
const thumbnailsRoot = join(assetsRoot, 'thumbnails')
const sheets = new Map<string, { image: string; frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }> }>()

function removeDetachedAtlasFragments(data: Buffer, width: number, height: number): Buffer {
  const labels = new Int32Array(width * height)
  const queue = new Int32Array(width * height)
  const components: { label: number; size: number }[] = []
  let nextLabel = 0
  let largest = 0
  for (let start = 0; start < width * height; start++) {
    if (data[start * 4 + 3]! < 8 || labels[start]) continue
    const label = ++nextLabel
    let head = 0
    let tail = 0
    queue[tail++] = start
    labels[start] = label
    while (head < tail) {
      const index = queue[head++]!
      const x = index % width
      const y = Math.floor(index / width)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const neighbor = ny * width + nx
        if (!labels[neighbor] && data[neighbor * 4 + 3]! >= 8) { labels[neighbor] = label; queue[tail++] = neighbor }
      }
    }
    components.push({ label, size: tail })
    largest = Math.max(largest, tail)
  }
  const keep = new Set(components.filter(component => component.size >= Math.max(24, largest * .7)).map(component => component.label))
  for (let index = 0; index < labels.length; index++) {
    if (!keep.has(labels[index]!)) data[index * 4 + 3] = 0
  }
  return data
}

async function createCleanAtlas(sheetId: string, sourceName: string, outputName: string) {
  const sourcePath = join(assetsRoot, sourceName)
  const metadataPath = sourcePath.replace(/\.png$/, '.json')
  const json = JSON.parse(await readFile(metadataPath, 'utf8'))
  const size = json.meta.size as { w: number; h: number }
  const overlays = []
  for (const entry of Object.values(json.frames) as { frame: { x: number; y: number; w: number; h: number } }[]) {
    const rect = entry.frame
    const crop = await sharp(sourcePath).extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }).ensureAlpha().raw().toBuffer()
    const clean = removeDetachedAtlasFragments(crop, rect.w, rect.h)
    overlays.push({ input: await sharp(clean, { raw: { width: rect.w, height: rect.h, channels: 4 } }).png().toBuffer(), left: rect.x, top: rect.y })
  }
  const outputPath = join(assetsRoot, outputName)
  await sharp({ create: { width: size.w, height: size.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(overlays).png().toFile(outputPath)
  json.meta.image = outputName
  await writeFile(outputPath.replace(/\.png$/, '.json'), JSON.stringify(json, null, 2) + '\n')
  const image = await readFile(outputPath)
  sheets.set(sheetId, { image: image.toString('base64'), frames: json.frames })
}

await createCleanAtlas('world', 'world-atlas.png', 'world-atlas-clean.png')
await createCleanAtlas('environment', 'environment-atlas.png', 'environment-atlas-clean.png')
await createCleanAtlas('persons', 'persons-atlas.png', 'persons-atlas-clean.png')

for (const sheet of contemporaryTheme.sheets) {
  if (sheets.has(sheet.id)) continue
  const relative = sheet.src.replace('/scene-assets/contemporary/', '')
  const imagePath = join(assetsRoot, relative)
  const json = JSON.parse(await readFile(imagePath.replace(/\.png$/, '.json'), 'utf8'))
  const image = await readFile(imagePath)
  sheets.set(sheet.id, { image: image.toString('base64'), frames: json.frames })
}

await mkdir(thumbnailsRoot, { recursive: true })
for (const asset of contemporaryTheme.assets.filter(item => item.capabilities.placeable)) {
  const source = sheets.get(asset.sprite.sheetId)
  const frame = source?.frames[asset.sprite.frame]?.frame
  if (!source || !frame) throw new Error(`Thumbnail source missing for ${asset.id}`)
  const png = await sharp(Buffer.from(source.image, 'base64'))
    .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
    .resize(78, 55, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: 8, bottom: 9, left: 9, right: 9, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const output = join(root, `web/public${asset.thumbnail}`)
  await mkdir(join(root, 'web/public/scene-assets/contemporary/thumbnails'), { recursive: true })
  await writeFile(output, png)
}
