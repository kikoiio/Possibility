// Tolerate only redundant JSON punctuation, never invent keys, values or array
// entries. The original response remains in the model audit.
export function parseGeneratedJSON(text) {
  if (typeof text !== 'string') throw new Error('模型没有返回 JSON 文本。');
  let input = text.trim(), adjustments = [];
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(input);
  if (fence) { input = fence[1].trim(); adjustments.push('移除 JSON 外层代码围栏'); }
  // Some compatible providers emphasize the entire JSON object. Unwrap only
  // that exact envelope; never strip asterisks from quoted speech or prose.
  const emphasis = /^\*\*\s*(\{[\s\S]*\})\s*\*\*$/.exec(input);
  if (emphasis) { input = emphasis[1]; adjustments.push('移除 JSON 对象外层强调标记'); }
  let output = '', quoted = false, escaped = false; const stack = [];
  for (let i=0;i<input.length;i++) {
    const ch=input[i];
    if (quoted) {
      // Compatible providers sometimes send literal line breaks inside a JSON
      // string. Escape those characters without changing the authored text.
      if (!escaped && ch.charCodeAt(0) < 32) { output += JSON.stringify(ch).slice(1, -1); adjustments.push(`转义字符串位置 ${i} 的控制字符`); continue; }
      output+=ch; if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;
    }
    if(ch==='"'){quoted=true;output+=ch;continue;}
    if(ch==='{'||ch==='[')stack.push(ch);
    if(ch==='}'||ch===']')stack.pop();
    if(ch===',') {
      let j=i+1;while(/\s/.test(input[j]||'')&&j<input.length)j++;
      if(input[j]==='}'||input[j]===']'||(input[j]===','&&stack.at(-1)==='{')) { adjustments.push(`移除位置 ${i} 的冗余逗号`);continue; }
    }
    output+=ch;
  }
  let value;try{value=JSON.parse(output);}catch{throw new Error('模型返回的 JSON 仍有无法安全解析的格式错误，世界未创建。');}
  return { value, adjustments };
}
