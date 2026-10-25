// 引擎模块 barrel。P1 各轨道按 docs/INTERFACES.md 的边界填充子模块;
// 各轨道只新增自己的子目录与测试,不改本文件以外的共享文件。
export * from './domain/index.js';
export * from './store/index.js';
export * from './clock/index.js';
export * from './llm/index.js';
