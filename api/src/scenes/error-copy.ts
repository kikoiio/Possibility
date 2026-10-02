export interface ContentIssueCopy {
  summary: string
  suggestion: string
}

export const CONTENT_ISSUE_FALLBACK: ContentIssueCopy = {
  summary: '场景结构还需要调整。',
  suggestion: '可以简化描述，减少复杂结构，并重新生成。',
}

export type ContentIssueCode =
  | 'out-of-bounds'
  | 'unknown-block'
  | 'floating-object'
  | 'object-overlap'
  | 'location-unbound'
  | 'locked-violation'
  | 'walk-clearance'
  | 'walk-connectivity'
  | 'walk-lighting'
  | 'walk-stairs'
  | 'walk-gap'
  | 'invalid-meta'
  | 'unknown-asset'
  | 'asset-overlap'

export const CONTENT_ISSUE_COPY: Record<ContentIssueCode, ContentIssueCopy> = {
  'out-of-bounds': {
    summary: '有些建筑或物件超出了场景范围。',
    suggestion: '可以缩小建筑和物件，或描述一个更宽敞的场地。',
  },
  'unknown-block': {
    summary: '场景里有无法识别的建筑材料或物件。',
    suggestion: '可以描述常见的建筑材料和物件，避免使用特殊材质名称。',
  },
  'floating-object': {
    summary: '有些建筑或物件没有稳当地放在地面上。',
    suggestion: '可以说明建筑和物件都要放在平整、连续的地面上。',
  },
  'object-overlap': {
    summary: '有些建筑或物件彼此挤在了一起。',
    suggestion: '可以拉开建筑和物件之间的距离，留出清楚的空地。',
  },
  'location-unbound': {
    summary: '有些描述中的地点还没有对应的建筑或标志。',
    suggestion: '可以为每个地点描述一个容易辨认的建筑或标志物。',
  },
  'locked-violation': {
    summary: '有些建筑之间发生了不兼容的重叠。',
    suggestion: '可以拉开主要建筑的距离，避免让其他物件穿过它们。',
  },
  'walk-clearance': {
    summary: '有门洞或走廊太矮，居民走不过去。',
    suggestion: '可以避免低矮狭窄的通道，或让场景采用更开阔的布局。',
  },
  'walk-connectivity': {
    summary: '有些地方被隔开了，居民无法走到。',
    suggestion: '可以减少隔断，或描述一条连通各处的道路。',
  },
  'walk-lighting': {
    summary: '有些室内通道太暗，不适合行走。',
    suggestion: '可以在室内通道和封闭空间增加灯具或窗户。',
  },
  'walk-stairs': {
    summary: '有些地面高低变化太突然，居民无法顺畅通行。',
    suggestion: '可以让相邻地面平缓衔接，或在高差处加入台阶。',
  },
  'walk-gap': {
    summary: '地面上有缺口，行走路线无法通过。',
    suggestion: '可以补平地面，或描述一条绕开缺口的连续路线。',
  },
  'invalid-meta': {
    summary: '场景的风格或地形设置无法使用。',
    suggestion: '可以简化地形和风格要求，选择常见、明确的场景元素。',
  },
  'unknown-asset': {
    summary: '场景里包含无法使用的物件。',
    suggestion: '可以描述常见的建筑和装饰，不指定特殊物件型号。',
  },
  'asset-overlap': {
    summary: '有些大型物件彼此重叠，或没有稳当地放在地面上。',
    suggestion: '可以拉开大型物件之间的距离，并确保它们放在平整地面上。',
  },
}
