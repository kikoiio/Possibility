import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../public/scene-assets/mist-manor')
const inventory = JSON.parse(await readFile(resolve(root, 'inventory.json'), 'utf8'))
const atlas = JSON.parse(await readFile(resolve(root, 'exterior-core.json'), 'utf8'))
await access(resolve(root, 'exterior-core.png'))
const png = await readFile(resolve(root, 'exterior-core.png'))
if (png.toString('ascii', 1, 4) !== 'PNG') throw new Error('exterior-core.png 不是 PNG')
const width = png.readUInt32BE(16); const height = png.readUInt32BE(20)
const required = ['manor-main', 'gatehouse', 'greenhouse', 'courtyard-pond', 'mountain-trail', 'town-road', 'garden-lantern-maple']
for (const id of required) {
  const frame = atlas.frames[id]?.frame
  if (!frame) throw new Error(`缺少外景帧 ${id}`)
  if (frame.w < 1 || frame.h < 1 || frame.x < 0 || frame.y < 0 || frame.x + frame.w > width || frame.y + frame.h > height) throw new Error(`外景帧越界 ${id}`)
  if (!inventory.frames.some(item => item.id === id && item.groundContact?.length === 2)) throw new Error(`清单缺少地面接触点 ${id}`)
}
const requiredLocations = ['大厅', '书房', '餐厅', '图书室', '温室花房', '门房小屋', '后山散步道']
for (const name of requiredLocations) if (!inventory.locations.includes(name)) throw new Error(`清单缺少地点 ${name}`)
if (inventory.residents.length !== 6) throw new Error('居民清单必须恰好包含六人')
console.log(`mist-manor assets ok: ${required.length} exterior frames, ${inventory.locations.length} locations, ${inventory.residents.length} residents`)
