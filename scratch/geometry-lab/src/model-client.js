export async function getSettings() {
  const response = await fetch('http://127.0.0.1:5174/lab-api/settings');
  if (!response.ok) throw new Error('模型实验服务未启动；固定配方仍可使用');
  return response.json();
}

export async function saveSettings(settings) {
  const response = await fetch('http://127.0.0.1:5174/lab-api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

export async function generateScene(instruction, document) {
  const response = await fetch('http://127.0.0.1:5174/lab-api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction, document }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
