import { createCampSceneDocument, validateCampSceneDocument } from './geometry/camp-document.js';
import { compileScene, disposeWorld } from './geometry/scene-compiler.js';
import { validateSceneDocument, validateSpatialLayout } from './geometry/scene-document.js';
import { createPlainMaterials } from './geometry/materials.js';

export { createCampSceneDocument };

export function checkSceneCandidate(document) {
  const generic = document?.profile === 'world';
  const errors = generic ? validateSceneDocument(document) : validateCampSceneDocument(document);
  if (generic && !errors.length) errors.push(...validateSpatialLayout(document));
  if (errors.length) return { ok: false, reason: 'invalid-scene', diagnostics: errors };
  let compiled; const materials = generic ? createPlainMaterials() : null;
  try {
    compiled = compileScene(document, 'solid', generic ? { materials, details: false } : {});
    return { ok: true, document: structuredClone(document) };
  } catch (error) {
    return { ok: false, reason: 'scene-compile-failed', diagnostics: error.diagnostics ?? [{ nodeId: 'scene', operationId: 'compile', requirementId: 'geometry', message: '场景未通过几何编译。' }] };
  } finally { if (compiled) disposeWorld(compiled); if (materials) for (const material of Object.values(materials)) material.dispose(); }
}

export function buildSceneMessages(instruction, document) {
  if (document.profile === 'world') return [
    { role: 'system', content: '根据作者要求修改当前 SceneDocument，仅返回完整 JSON。保留 schemaVersion/profile/id、全部物件身份、character 出生位置及人物绑定，不写入模拟资源或记忆。使用现有语义类型和字段，只修改支持的外观和几何参数；陆地、建筑、道路和人物空间应继续成立。不能包含代码、URL或配置。结果将先编译校验，预览确认后应用。' },
    { role: 'user', content: JSON.stringify({ instruction, document }) },
  ];
  return [
    { role: 'system', content: `你是 Wispiva 场景设计者，根据文字修改现有 SceneDocument。只返回完整 JSON，不要 markdown。\n保留 schemaVersion、profile、id、所有实体 id/kind、工作站位置和模拟绑定。可修改已有文档允许的颜色、造型、屋顶和装饰参数，不能虚构新字段、新类型或删除必要物件。\n不允许在场景里写入水量、植物健康、货物状态、角色行动或任何模拟事实；这些来自独立的权威世界。文档不能包含代码、脚本、URL或模型配置。以提供的 example 和当前文档为字段规范；不支持的请求只在现有参数范围内表达，不制造不可执行内容。\n模型结果先进入待确认草稿，由程序校验结构、空间与实际编译；只生成数据。` },
    { role: 'user', content: JSON.stringify({ instruction, document, example: createCampSceneDocument() }) },
  ];
}
