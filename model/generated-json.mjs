function objectCandidates(input) {
  const candidates = [];
  for (let start = 0; start < input.length; start += 1) {
    if (input[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const ch = input[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push({ text: input.slice(start, index + 1), start, end: index + 1 });
          break;
        }
      }
    }
  }
  return candidates;
}

// Tolerate only redundant JSON punctuation, never invent keys, values or array
// entries. The original response remains in the model audit. Some compatible
// providers prepend a short explanation even when JSON mode is requested; that
// fallback is opt-in so strict callers continue rejecting surrounding prose.
export function parseGeneratedJSON(text, { allowEmbeddedObject = false, requiredKeys = [] } = {}) {
  if (typeof text !== 'string') throw new Error('模型没有返回 JSON 文本。');
  let input = text.trim(), adjustments = [];
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(input);
  if (fence) { input = fence[1].trim(); adjustments.push('移除 JSON 外层代码围栏'); }
  // Some compatible providers emphasize the entire JSON object. Unwrap only
  // that exact envelope; never strip asterisks from quoted speech or prose.
  const emphasis = /^\*\*\s*(\{[\s\S]*\})\s*\*\*$/.exec(input);
  if (emphasis) { input = emphasis[1]; adjustments.push('移除 JSON 对象外层强调标记'); }
  if (allowEmbeddedObject && !/^\s*\{/.test(input)) {
    const matches = objectCandidates(input).map(candidate => {
      try { return { candidate, parsed: parseGeneratedJSON(candidate.text) }; }
      catch { return null; }
    }).filter(Boolean);
    const matching = matches.filter(({ parsed }) => requiredKeys.every(key => Object.hasOwn(parsed.value, key)));
    const usable = matching.length ? matching : matches;
    if (usable.length) {
      // When a provider leaks a long analysis before the final JSON, the
      // useful object is usually the last matching one. Prefer that object;
      // choosing the longest candidate can accidentally select an earlier
      // example embedded in the analysis.
      const selected = usable.sort((a, b) => b.candidate.end - a.candidate.end || a.candidate.text.length - b.candidate.text.length)[0];
      input = selected.candidate.text;
      adjustments.push('从模型附带的说明文字中提取 JSON 对象');
    }
  }
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
  let value;
  try { value = JSON.parse(output); }
  catch {
    // A complete root followed by extra root properties has one redundant
    // closing brace. Both halves must independently parse, with disjoint keys;
    // never discard trailing properties or let them overwrite earlier values.
    const root = output.startsWith('{') && objectCandidates(output).find(c => c.start === 0);
    const suffix = root && output.slice(root.end).trim();
    try {
      if (!suffix?.startsWith(',')) throw new Error();
      const first = JSON.parse(root.text), trailing = JSON.parse(`{${suffix.slice(1)}`);
      if (Object.keys(trailing).some(key => Object.hasOwn(first, key))) throw new Error();
      value = JSON.parse(root.text.slice(0, -1) + suffix);
      adjustments.push('移除提前关闭根对象的冗余右括号，保留其后全部字段');
    } catch { throw new Error('模型返回的 JSON 仍有无法安全解析的格式错误，世界未创建。'); }
  }
  return { value, adjustments };
}
