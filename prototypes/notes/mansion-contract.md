# 山庄片段：本轮共享约定

在同一 `prototypes/` 原型实现封闭山庄当晚的信息差推演。角色与事件由新 LLM 调用生成；使用《假面山庄》的有限空间/秘密/相互怀疑作为参考，人物与具体事件允许原创，界面明确为灵感实验，不宣称逐章复现原作。

## 数据契约

仍使用 `world.profile=generated-world`、`scene.profile=world`，保留原世界字段。`world` 新增可选 `story`：

```js
story: {
  premise: '今晚的起点，不包含未来剧情',
  connections: [{from: 'hall', to: 'study'}], // 无向，相邻房间才可移动
  facts: [{id: 'fact-a', text: '客观事实或前史', knownBy: ['actor-a']}],
  clues: [{id: 'letter', name: '折叠的信', location: 'study', detail: '检查后才能知道的内容', discoveredBy: []}],
  conversations: [] // 创世必须为空；运行时由引擎追加
}
```

对话运行记录：`{id,speakerId,location,minute,text,listeners:[actorIds]}`。listeners 为当时同房间的其他人；说话者也可读自己说的话。听到不代表相信，证词不写入客观 facts。

人物行动新增 `{"type":"speak","text":"一句话"}`、`{"type":"inspect","clueId":"letter"}`；原 moveTo/rest/observe/perform 保留。inspect 仅当前房间线索可执行，成功后把本人加入 discoveredBy。moveTo 在 story 世界只能沿 connections。

角色观察仍含 `places`（当前及相邻可去地点）、`neighbors`（仅同房间其他人）、原有自身字段；新增 `story:{premise,knownFacts,visibleClues,knownClues,statements}`。knownFacts 为已知事实，不包含别人秘密；visibleClues 只有当前房间的 id/name/location，无 detail；knownClues 为本人已经检查过的线索，含 detail；statements 只包含本人说过/作为 listeners 当场听见的记录。角色提示只用这一投影，不传完整 story。

## 室内几何

SceneDocument 新增 `kind:'room'` 物件：

```js
{id:'hall',kind:'room',name:'会客厅',
 transform:{position:[-4,0,0],rotation:0},
 bounds:{width:7,depth:7,wallHeight:2.8,floor:0.8}}
```

开放屋顶、剖面房间，使用现有 solid/voxel 编译器。world.place 可选 `roomId` 引用 scene room；position 是房内地点中心、y 等于 room 地板世界高程。room 不是阻挡房内人物的建筑实体。房间不互相重叠、仍需要陆地支持；地点必须位于绑定房间范围内。本轮只做房间图上的抽象移动，不做室内寻路或逐步碰撞。

## 所有权

- 主 agent：world-definition、actor、world-genesis、world-creation、server、公共生成输入、部署/存档清理、PLAN/主文档及集成。
- 几何 worker：geometry/（不改 world-definition）、ui/world-scene.js 的室内显示与投影、室内 CPU 观察脚本。
- UI worker：ui/index.html、app.js、style.css、ui/scene.js，以及 observe-ui.mjs。不改 ui/world-scene.js 或 geometry/。
- 所有 worker：不得读取/展示实际 `.env` 或 `config.json`；不得调用真实模型、启动服务/浏览器、安装依赖、执行重型构建/全套测试或删除实际存档。轻量读写及定向 CPU 检查可用；未计划重型工作先与主 agent 协调。
