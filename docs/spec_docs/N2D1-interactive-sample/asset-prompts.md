# N2D1 素材生成 Prompt 与落位说明（T20–T27）

> 用途：你拿这些 prompt 去生图工具生成 PNG，按「落位」列的路径放入仓库，我随后做 T28 汇合校准。
> 几何契约已冻结（`web/src/native2d/assets.ts`），**尺寸与脚点不能变**；生成后若内容与设计有出入，优先调图，不调整契约。

## 通用要求（每张图都适用）

- **视角**：固定 2:1 斜俯视（等距投影），从南向北看。所有素材同一视角、同一光照方向（左上方冷色环境光）。
- **风格**：冷色悬疑——青灰、墨蓝、石板灰为主调，低饱和；局部暖光（窗灯、门灯）为唯一暖色来源。参考方向见 `design/cold-mystery-reference-v1.png`（仅风格参考，不要裁切它）。
- **背景必须透明**（PNG alpha）。不画地面、不画人物、不画文字、不画阴影投影到画面外（物件自身投影可以画在物件下方，但限制在画面内）。
- **脚点（anchor）**：每张图有一个「脚点」像素坐标，是素材在网格上的对齐基准。**同一素材的所有图层必须是同一画布尺寸**，脚点位置一致，叠加时严丝合缝。生成时让物件的地面接触基准点落在这个像素上。
- **分层规则**：
  - `base`：物件主体。
  - `occluder`：物件的「前景遮挡」部分（如屋檐前缘、树冠、前景墙），其余全透明。当居民走到物件南侧被遮住时，引擎只显示这一层盖住居民，并可在选中居民时单独淡出。**base 层不应包含 occluder 已画的内容**（两层合起来才是完整物件）。
  - `accent`：只画暖光部分（亮起的窗户、门灯光晕），其余全透明。引擎仅在黄昏/夜晚显示这一层。
- 生成多张同素材图层时的实用做法：先生成完整物件图，再分别导出「主体（去掉前景遮挡部分）」「仅前景遮挡」「仅暖光」三张，同画布尺寸。

## 一、建筑（落位 `web/public/native2d/mist-manor/buildings/`）

### 1. 主楼 main-house —— 288×264 px，脚点 (128,144)，占地 4×3 格

大正末期石造洋房主楼，三开间两层带坡屋顶，南向（画面右下方向）正中偏右有正门。冷灰石墙、墨蓝石板瓦、爬藤。脚点位于建筑底面菱形（4×3 格，投影后宽 256px、深 112px）的北顶角；即建筑底部菱形占画面下半部（脚点 y=144 以下约 112px），墙体与屋顶向上延伸约 140px。

| 文件 | 内容 |
|---|---|
| `main-house-base.png` | 主楼主体（墙体、屋顶后部、门窗框架、爬藤），不含前景屋檐 |
| `main-house-occluder.png` | 仅前景部分：南面屋檐前缘与门廊顶（会挡住站在正门前的人），其余透明 |
| `main-house-accent.png` | 仅暖光：亮起的窗格与正门门灯光晕，其余透明 |

Prompt 示例（base）：
> Isometric 2:1 pixel-perfect game asset of a late-Taisho era stone manor house, two stories, three bays, dark slate gabled roof, ivy on cold grey stone walls, front door centered on the south face, cold blue-grey palette, muted, mysterious night atmosphere, unlit windows (no warm light), transparent background, no ground, no people, no text, clean silhouette, 288x264 canvas with the building base anchored at bottom center

（occluder/accent 在同一画布上只保留对应部分。）

### 2. 温室 greenhouse —— 224×200 px，脚点 (96,112)，占地 3×2 格

玻璃顶维多利亚式小花房，深色铁框架，玻璃带雾气结露，内部隐约见兰草与花盆轮廓。入口在南面（+z 面）中间。底面菱形 3×2 格（宽 192px、深 80px）在脚点下方。

| 文件 | 内容 |
|---|---|
| `greenhouse-base.png` | 温室主体（铁框、玻璃、内部植物剪影），不含前景框缘 |
| `greenhouse-occluder.png` | 仅南面下沿铁框与入口门框前缘 |
| `greenhouse-accent.png` | 仅内部暖色灯光透过玻璃的光晕 |

Prompt 示例（base）：
> Isometric 2:1 game asset of a small Victorian glass greenhouse, dark iron frame, fogged glass panels, faint silhouettes of orchids and pots inside, cold blue-grey palette, unlit (no warm glow), transparent background, no ground, no people, 224x200 canvas

### 3. 门房 gatehouse —— 192×176 px，脚点 (96,104)，占地 2×2 格

庄门旁的小木屋，一层，坡屋顶，小窗与木门，门口有灯（未点亮）。最小建筑，气质朴素。底面菱形 2×2 格（宽 128px、深 64px）在脚点下方。

| 文件 | 内容 |
|---|---|
| `gatehouse-base.png` | 门房主体，不含前景屋檐 |
| `gatehouse-occluder.png` | 仅南面屋檐前缘 |
| `gatehouse-accent.png` | 仅门口暖灯与亮窗 |

Prompt 示例（base）：
> Isometric 2:1 game asset of a small wooden gatehouse cottage, one story, gabled roof, tiny window and wooden door on the south face, cold desaturated brown-grey palette, mysterious, unlit lamp by the door, transparent background, no ground, no people, 192x176 canvas

## 二、地形（落位 `web/public/native2d/mist-manor/terrain/`）—— 单格菱形 64×32 px，脚点 (32,0)

每块是**一个菱形地砖**（2:1 投影：宽 64、高 32 的菱形，顶角在 (32,0)），可无缝平铺。不画任何建筑/人物/家具。

| 文件 | 内容 |
|---|---|
| `ground.png` | 冷色草地/苔藓地面，深青灰绿，低明度，轻微纹理变化 |
| `path.png` | 石板通路，明度明显高于 ground（冷灰中带亮），石板缝清晰，边缘能与 ground 自然过渡 |
| `shore.png` | 水岸过渡格：一半湿石滩一半深水（墨蓝），用于庭院水景边缘装饰 |

Prompt 示例（path）：
> Seamless isometric 2:1 game floor tile, single diamond 64x32 px, weathered stone slab path, cool grey with slightly higher brightness than dark mossy grass, crisp stone seams, top-down oblique view, texture fills the diamond exactly, transparent outside the diamond

## 三、植被（落位 `web/public/native2d/mist-manor/terrain/`）

### 树 tree —— 128×160 px，脚点 (64,120)，两层

杉木/针叶树（后山杉木林气质），低饱和墨绿。树干基部接触地面处对齐脚点；脚点下方留 40px 给根部与单格菱形余量。

| 文件 | 内容 |
|---|---|
| `tree-base.png` | 树干与根部（可含最低层枝叶），树冠部分透明 |
| `tree-occluder.png` | 仅树冠（会挡住树后的人），其余透明 |

### 灌木 shrub —— 96×64 px，脚点 (48,24)，单层

低灌木丛，不遮挡通路。脚点在灌木底部中心。

Prompt 示例（tree-base）：
> Isometric 2:1 game asset, cedar tree trunk and root base only (canopy omitted/transparent), desaturated dark green-brown, cold mysterious forest mood, transparent background, 128x160 canvas, trunk base anchored at bottom center

## 四、大厅（落位 `web/public/native2d/mist-manor/hall/`）

### 地面 floor —— 352×176 px，脚点 (160,0)

6×5 格室内地板，精确填满整个菱形（宽 352=（6+5)×32、高 176=(6+5)×16）。大正洋馆木地板+局部地毯，暖炉房气质但整体冷调。不画家具。

### 墙体 —— 352×256 px，脚点 (160,80)，两层，与 floor 同一平面

墙体在地板平面的北/西边缘向上立起 80px（脚点 y=80 以下是地板区域，以上是墙面）。**floor 与 wall 合成时地板区域严格对齐**（floor 脚点 (160,0) vs wall 脚点 (160,80)：wall 图底部 176px 与 floor 全图重叠区域一致，该区域在 wall 两层中应透明或只画墙根线）。

| 文件 | 内容 |
|---|---|
| `wall-base.png` | 后墙（北侧与西侧墙：墙板、挂钟、挂画、窗），南向开口处留出入口 |
| `wall-occluder.png` | 前景墙（南侧与东侧矮墙/墙裙前缘，会挡住靠近南边的居民），其余透明 |

### 家具（T26，单层，不画人物）

| 文件 | 尺寸/脚点 | 内容 |
|---|---|---|
| `table.png` | 128×88，脚点 (48,32) | 长木桌（占地 2×1），桌上可有烛台/茶具 |
| `chair.png` | 96×80，脚点 (48,40) | 单把木椅，面向桌子方向 |
| `lamp.png` | 96×128，脚点 (48,88) | 落地灯/暖炉灯，**可带暖色光**（单层烘焙，是全场景少数暖色之一） |

Prompt 示例（table）：
> Isometric 2:1 game asset, long wooden dining table for a Taisho-era western manor hall, dark wood, small candelabra and tea set on top, cold muted palette, transparent background, no people, 128x88 canvas

## 五、居民（落位 `web/public/native2d/mist-manor/residents/`）—— 40×56 px，脚点 (20,40)，共 3 张

静态全身像，约 1/2 格宽（身宽 ≤24px）。脚底对齐：脚点在人物脚底所站格子的北顶角，脚底约在脚点下方 16px（即画面 y≈56 附近为脚底）。冷色衣饰、轮廓清楚（深色地面和室内都可辨认），大正—昭和过渡期服装。三人是同一居民的三种表现还是三位不同居民均可，但三张之间比例必须一致、风格统一。不画动作帧。

| 文件 | 建议形象 |
|---|---|
| `resident-a.png` | 男性，深色和服外套/袴，戴帽（侦探气质，对应雾野透） |
| `resident-b.png` | 老年男性，深色羽织，持杖（庄主气质，对应白川宗一郎） |
| `resident-c.png` | 女性，深色女仆装/和服（对应小夜） |

Prompt 示例（resident-a）：
> Isometric 2:1 game character sprite, full body static standing pose, Taisho-era Japanese detective in dark kimono coat and hat, cold desaturated palette, clear readable silhouette on dark backgrounds, transparent background, no ground shadow beyond feet, 40x56 canvas, feet at bottom center

## 交付检查（你放图后我会逐项核对）

1. 每张图的实际像素尺寸与本表一致；同素材各层同尺寸。
2. 背景透明（alpha），无烘焙地面/人物/文字。
3. 脚点附近有明确的地面接触基准；同素材各层叠加无错位。
4. accent 层只有暖光；occluder 层只有前景部分；地形格可平铺。
5. 文件路径与文件名与本表逐字一致（共 24 张）。
