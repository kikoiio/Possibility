export const SEED = {
  title: '临江 · 戏台浮出水面的那一天',
  premise: '临江镇的水位退去，露出一座沉没六十年的戏台。四个人各怀心事，旧照片上的第五个人仍然没有姓名。让故事由人物的选择自然发展，不要求固定结局。',
  rules: ['这是一个没有超自然力量的当代小镇。用户可以自由改写这条设定。'],
  entities: {
    tea: { kind: 'place', name: '青梧茶馆', x: 22, z: 24, width: 23, depth: 17, height: 12, color: '#aa7657' },
    ferry: { kind: 'place', name: '老渡口', x: 75, z: 24, width: 23, depth: 14, height: 5, color: '#819d91' },
    hall: { kind: 'place', name: '镇公所', x: 25, z: 73, width: 24, depth: 19, height: 16, color: '#c4a66c' },
    stage: { kind: 'place', name: '江底戏台', x: 75, z: 73, width: 25, depth: 20, height: 9, color: '#8d9d98' },
    shen: { kind: 'character', name: '沈青梧', location: 'tea', color: '#b45e52', goal: '保住茶馆，弄清父亲留下的旧照片', personality: '谨慎、护短、记性很好', state: '望着刚露出的戏台', knowledge: ['老周认识照片上的第五个人'] },
    lu: { kind: 'character', name: '陆则', location: 'ferry', color: '#487c99', goal: '写出一篇让自己不再逃避故乡的报道', personality: '敏锐、冲动，有点嘴硬', state: '刚下渡船', knowledge: [] },
    zhou: { kind: 'character', name: '老周', location: 'ferry', color: '#8e8245', goal: '守住一个六十年的承诺', personality: '沉默，但不会轻易撒谎', state: '收起渡船的缆绳', knowledge: ['第五个人是沈青梧的外祖母，她当年活着离开了小镇'] },
    bai: { kind: 'character', name: '白薇', location: 'hall', color: '#8e6f92', goal: '推动古镇开发，同时避免居民被迫搬离', personality: '精明、讲条件，也有底线', state: '等待测绘队的电话', knowledge: ['开发商希望三天内封闭戏台'] },
  },
  memories: [
    { id: 'promise-zhou', text: '老周答应过照片中的女人，未经她同意不公开她离开小镇的去向。', knownBy: ['zhou'], source: 'initial' },
  ],
};

export const GROQ_MODELS = [
  { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B · 主推演', strict: true },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B · 中文候选 / Preview', strict: true },
  { id: 'openai/gpt-oss-20b', label: 'GPT OSS 20B · 快速备用', strict: true },
];

export function sceneOf(world, worldTime, revisionId) {
  const places = Object.entries(world.entities).filter(([, e]) => e.kind === 'place');
  const locations = places.map(([id, e]) => ({
    id, name: e.name || id, x: Number.isFinite(e.x) ? e.x : 50, z: Number.isFinite(e.z) ? e.z : 50,
    width: Number(e.width) || 15, depth: Number(e.depth) || 12,
    height: Number(e.height) || 8, color: e.color || '#a99880',
  }));
  const occupants = new Map();
  const characters = Object.entries(world.entities).filter(([, e]) => e.kind === 'character').map(([id, e]) => {
    const p = locations.find(l => l.id === e.location) || { x: 50, z: 50 };
    const slot = occupants.get(e.location) || 0;
    occupants.set(e.location, slot + 1);
    return { id, name: e.name || id, x: e.position?.x ?? p.x - 5 + slot * 7, z: e.position?.z ?? p.z + 8, color: e.color || '#4b7770' };
  });
  return { revisionId, worldTime, locations, characters };
}
