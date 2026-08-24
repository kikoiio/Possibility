-- 人格档案存储：源文件在 personas/ 仓库目录，发布脚本写入本表，运行时从本表读取。
-- 新增居民 = 加文件 + 跑发布脚本，零代码改动（G4 / checklist 场景 5）。
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  raw TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);
