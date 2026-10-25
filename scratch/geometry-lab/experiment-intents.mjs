import { libraryScene, villageScene } from './src/scene-document.js';

// 每个意图都带一份手工参考解（reference）：既证明意图在子集内有可行解，
// 也让 mock 模式能用参考解跑通整条编译与修订管道。校验器是唯一裁判。
const base = () => structuredClone(libraryScene);

// 门廊贴着 library front 入口摆放，随 library 旋转。
function placePorch(doc) {
  const library = doc.objects.find(o => o.kind === 'library');
  const porch = doc.objects.find(o => o.kind === 'porch');
  porch.transform.rotation = library.transform.rotation;
  const offset = library.bounds.depth / 2 + porch.bounds.depth / 2;
  const a = library.transform.rotation;
  porch.transform.position = [
    library.transform.position[0] + offset * Math.sin(a),
    library.transform.position[1],
    library.transform.position[2] + offset * Math.cos(a),
  ];
}

function intent(id, title, text, build, revision) {
  const reference = build(base());
  reference.id = id;
  reference.title = title;
  return { id, title, text, reference, revision };
}

const widenPorch = '把门廊加宽 1.2 米，其余一切保持原样。';

export const intents = [
  intent(
    'rotated-cove', '转角水湾',
    '在半径 11.5 米的圆形小岛上建一座朝向东南（约 0.35 弧度）的临水藏书屋，门廊正对入口，木桥从岛边接向登陆小岛，保持基础场景的桥和树的位置风格。',
    doc => {
      doc.objects.find(o => o.kind === 'library').transform.rotation = 0.35;
      placePorch(doc);
      return doc;
    },
    { instruction: widenPorch, expectParts: ['porch'] },
  ),
  intent(
    'twin-islands', '双岛长桥',
    '两座岛：主岛半径 12 米，正北 34 米外有一座半径 5 米、高程 1.2 米的登陆小岛，一座长木桥相连。屋子朝北，方便从桥上直接进门廊。',
    doc => {
      const island = doc.regions.find(r => r.id === 'island');
      island.radius = 12;
      const landing = doc.regions.find(r => r.id === 'landing');
      landing.center = [0, 34];
      landing.radius = 5;
      landing.elevation = 1.2;
      doc.objects.find(o => o.kind === 'library').transform.rotation = Math.PI / 2;
      placePorch(doc);
      const bridge = doc.objects.find(o => o.kind === 'bridge');
      bridge.from = { region: 'island', point: [8, 0.9, 4.5] };
      bridge.to = { region: 'landing', point: [1.2, 1.2, 31] };
      bridge.segments = 40;
      doc.objects.find(o => o.id === 'tree-landing').position = [0, 1.2, 36];
      return doc;
    },
    { instruction: widenPorch, expectParts: ['porch'] },
  ),
  intent(
    'compact-cabin', '紧凑小屋',
    '一间紧凑的小藏书屋（约 5.5×5 米、墙高 4 米），小岛半径只有 8 米。屋子虽小，室内要留出走动空间，入口宽 2.2 米。',
    doc => {
      const library = doc.objects.find(o => o.kind === 'library');
      library.bounds = { width: 5.5, depth: 5, wallHeight: 4, floor: 1.4 };
      library.entrance = { wall: 'front', width: 2.2, height: 3.2 };
      library.roof = { kind: 'gable', rise: 2, overhang: 0.5 };
      library.windows = [{ wall: 'front', offset: -1.6 }, { wall: 'front', offset: 1.6 }];
      const porch = doc.objects.find(o => o.kind === 'porch');
      porch.bounds = { width: 5, depth: 2.2, floor: 1.25 };
      placePorch(doc);
      doc.regions.find(r => r.id === 'island').radius = 8;
      const bridge = doc.objects.find(o => o.kind === 'bridge');
      bridge.from = { region: 'island', point: [5, 0.9, 3] };
      bridge.segments = 20;
      for (const [id, position] of [['tree-north', [-3.8, 0.8, -3.8]], ['tree-east', [5.8, 0.8, -1.5]], ['tree-west', [-5.5, 0.8, 2]]]) {
        const tree = doc.objects.find(o => o.id === id);
        tree.position = position;
        tree.scale = 0.3;
      }
      return doc;
    },
    { instruction: widenPorch, expectParts: ['porch'] },
  ),
  intent(
    'high-terrace', '高台藏书屋',
    '主岛是高出水面 2.4 米的高台，屋子地板抬高到 3.0 米，墙加高到 5.5 米、入口加高到 3.9 米；桥向下接到 1.2 米高的登陆岛。',
    doc => {
      doc.regions.find(r => r.id === 'island').elevation = 2.4;
      doc.regions.find(r => r.id === 'landing').elevation = 1.2;
      const library = doc.objects.find(o => o.kind === 'library');
      library.bounds.wallHeight = 5.5;
      library.bounds.floor = 3.0;
      library.entrance = { wall: 'front', width: 2.6, height: 3.9 };
      doc.objects.find(o => o.kind === 'porch').bounds.floor = 2.85;
      const bridge = doc.objects.find(o => o.kind === 'bridge');
      bridge.from.point = [7.2, 2.4, 4.5];
      bridge.to.point = [16.5, 1.2, 6];
      for (const id of ['tree-north', 'tree-east', 'tree-west']) {
        const tree = doc.objects.find(o => o.id === id);
        tree.position[1] = 2.4;
      }
      doc.objects.find(o => o.id === 'tree-landing').position[1] = 1.2;
      return doc;
    },
    { instruction: widenPorch, expectParts: ['porch'] },
  ),
  intent(
    'grove', '林间书亭',
    '想要树多一点的林间藏书屋：六棵树环绕小屋和小岛，注意树冠不要碰到建筑，也不要挡住桥上的通道和门廊入口。',
    doc => {
      const specs = [
        ['tree-north', [-6, 0.8, -5]],
        ['tree-west', [-7, 0.8, 2]],
        ['tree-east', [0, 0.8, -8]],
        ['tree-landing', [4, 0.8, -7]],
      ];
      for (const [id, position] of specs) {
        const tree = doc.objects.find(o => o.id === id);
        tree.position = position;
        tree.scale = 0.35;
      }
      const bridge = doc.objects.find(o => o.kind === 'bridge');
      bridge.from.point = [7.2, 0.9, 4.5];
      doc.objects.push(
        { id: 'tree-meadow', kind: 'tree', position: [9.5, 0.8, 1], scale: 0.35, seed: 421 },
        { id: 'tree-shore', kind: 'tree', position: [14.5, 0.61, 8.5], scale: 0.35, seed: 907 },
      );
      return doc;
    },
    { instruction: widenPorch, expectParts: ['porch'] },
  ),
  intent(
    'grand-hall', '临水大厅',
    '一座更气派的临水大厅：10×7 米、墙高 5 米、屋顶更高，入口加宽到 4.2 米，门廊也要跟着宽敞（宽 7.5 米、深 2.8 米）；小岛相应加大到半径 13 米。',
    doc => {
      const library = doc.objects.find(o => o.kind === 'library');
      library.bounds = { width: 10, depth: 7, wallHeight: 5, floor: 1.48 };
      library.entrance = { wall: 'front', width: 4.2, height: 4.4 };
      library.roof = { kind: 'gable', rise: 3, overhang: 0.65 };
      const porch = doc.objects.find(o => o.kind === 'porch');
      porch.bounds = { width: 7.5, depth: 2.8, floor: 1.32 };
      placePorch(doc);
      doc.regions.find(r => r.id === 'island').radius = 13;
      const bridge = doc.objects.find(o => o.kind === 'bridge');
      bridge.from.point = [8.5, 0.9, 4.5];
      bridge.segments = 24;
      return doc;
    },
    { instruction: widenPorch, expectParts: ['porch'] },
  ),
  // 仅 mock 运行：验证失败路径的记录不会让管道崩溃。
  {
    id: 'mock-broken',
    title: '损坏样例（仅 mock）',
    text: '入口只有 0.7 米宽的小屋。',
    mockOnly: true,
    reference: (() => {
      const doc = base();
      doc.objects.find(o => o.kind === 'library').entrance.width = 0.7;
      return doc;
    })(),
    revision: null,
  },
];

export const defaultIntentIds = intents.filter(i => !i.mockOnly).map(i => i.id);

// ---- 村庄组:模糊 prompt(真实用户不会给参数),model 自己填所有细节 ----

const villageIntent = (id, title, text, build) => {
  const reference = build(structuredClone(villageScene));
  reference.id = id;
  reference.title = title;
  return { id, title, text, reference, revision: { instruction: widenPorch, expectParts: ['porch'] }, flavor: 'village' };
};

export const villageIntents = [
  villageIntent('v1-quayside', '小渔村',
    '在湖心的小岛上做一个安静的小渔村：有几户人家，一条石板小路把家门前串起来，村里有座带门廊的藏书屋当书院，村口有座木桥通到对岸的小岛，再种些树。',
    doc => doc),
  villageIntent('v2-hilltop', '山坡村落',
    '村子想建在高一点的水上山包上，书院还是要最好的位置，桥从山脚接到对面低一点的岸，住户和树都跟着台地的高程走。',
    doc => {
      doc.regions.find(r => r.id === 'island').elevation = 2.4;
      doc.regions.find(r => r.id === 'landing').elevation = 1.2;
      doc.objects.find(o => o.kind === 'library').bounds.floor = 3.1;
      doc.objects.find(o => o.kind === 'porch').bounds.floor = 2.95;
      for (const house of doc.objects.filter(o => o.kind === 'house')) house.bounds.floor = 2.7;
      for (const tree of doc.objects.filter(o => o.kind === 'tree')) {
        tree.position[1] = tree.id === 'tree-landing' ? 1.2 : 2.4;
      }
      doc.objects.find(o => o.kind === 'bridge').from.point[1] = 2.4;
      doc.objects.find(o => o.kind === 'bridge').to.point[1] = 1.2;
      return doc;
    }),
  villageIntent('v3-scattered', '人丁兴旺',
    '想要个人丁兴旺的大村子，六七户人家散在岛上，小路像树杈一样从书院门前分出去通到各处，房子之间别互相挡门挡路。',
    doc => {
      doc.regions.find(r => r.id === 'island').radius = 18;
      doc.objects = doc.objects.filter(o => o.id !== 'tree-east');
      doc.objects.push(
        {
          id: 'h5', kind: 'house', name: '渔家戊',
          transform: { position: [2, 0, -9.5], rotation: 0 },
          bounds: { width: 4.6, depth: 3.6, wallHeight: 3.1, floor: 1.1 },
          roof: { kind: 'gable', rise: 1.3, overhang: 0.4 },
          entrance: { wall: 'front', width: 1.5, height: 2.3 },
        },
        {
          id: 'h6', kind: 'house', name: '渔家己',
          transform: { position: [12.5, 0, 0.5], rotation: 0 },
          bounds: { width: 4.6, depth: 3.6, wallHeight: 3.1, floor: 1.1 },
          roof: { kind: 'gable', rise: 1.3, overhang: 0.4 },
          entrance: { wall: 'front', width: 1.5, height: 2.3 },
        },
        { id: 'tree-grove', kind: 'tree', position: [-13.5, 0.8, 2], scale: 0.35, seed: 2053 },
      );
      doc.objects.find(o => o.id === 'lane-main').points = [[1.8, 6.8], [1.8, 10.4]];
      doc.objects.push({ id: 'lane-east', kind: 'path', name: '东路', points: [[1.8, 8.6], [5.5, 10.6], [9, 9], [11.5, 4.5]], width: 0.9 });
      return doc;
    }),
  villageIntent('v4-compact', '紧凑渔村',
    '小岛上挤一点也没关系，做个紧凑的小渔村：几户人家挨着书院，但屋子和屋子、屋子和路之间都要留出过得走的空间。',
    doc => {
      doc.regions.find(r => r.id === 'island').radius = 12;
      const library = doc.objects.find(o => o.kind === 'library');
      library.bounds = { width: 7.6, depth: 6, wallHeight: 4.2, floor: 1.45 };
      library.entrance = { wall: 'front', width: 2.2, height: 3.2 };
      library.roof = { kind: 'gable', rise: 2.2, overhang: 0.5 };
      library.windows = [{ wall: 'front', offset: -2.4 }, { wall: 'front', offset: 2.4 }];
      doc.objects.find(o => o.kind === 'porch').bounds = { width: 5, depth: 2.2, floor: 1.3 };
      doc.objects.find(o => o.kind === 'porch').transform.position = [0, 0, 4.1];
      const houseSpec = [['h1', [-7, 0, -3.5]], ['h2', [6.8, 0, -2.5]], ['h3', [-2, 0, 7.5]]];
      doc.objects = doc.objects.filter(o => o.id !== 'h4');
      const houses = doc.objects.filter(o => o.kind === 'house');
      houses.forEach((house, i) => {
        house.id = houseSpec[i][0];
        house.transform.position = houseSpec[i][1];
        house.bounds = { width: 4, depth: 3.2, wallHeight: 2.9, floor: 1.1 };
        house.roof = { kind: 'gable', rise: 1.2, overhang: 0.35 };
        house.entrance = { wall: 'front', width: 1.3, height: 2.1 };
      });
      doc.objects.find(o => o.kind === 'bridge').from.point = [5.5, 0.9, 2];
      doc.objects.find(o => o.kind === 'bridge').segments = 20;
      doc.objects.find(o => o.id === 'lane-main').points = [[1.6, 6.9], [1.6, 10.2]];
      doc.objects.find(o => o.id === 'lane-main').width = 0.9;
      doc.objects.find(o => o.id === 'tree-north').position = [-9, 0.8, 1];
      doc.objects = doc.objects.filter(o => o.id !== 'tree-west' && o.id !== 'tree-east');
      return doc;
    }),
];

export const villageIntentIds = villageIntents.map(i => i.id);
