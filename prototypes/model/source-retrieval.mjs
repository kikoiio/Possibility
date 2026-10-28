const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const WORD = /[a-z0-9_]/iu;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase();

function terms(value) {
  const input = normalize(value);
  const found = new Set(input.match(/[a-z0-9_]{2,}|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/giu) ?? []);
  for (const run of input.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) found.add(run.slice(i, i + 2));
  }
  return [...found].filter(term => term.length > 1);
}

function chunkSource(text, size = 1400, overlap = 180) {
  const chunks = [];
  for (let start = 0; start < text.length; start += Math.max(1, size - overlap)) {
    const end = Math.min(text.length, start + size);
    const excerpt = text.slice(start, end).trim();
    if (excerpt) chunks.push({ id: `source-${chunks.length + 1}`, start, end, text: excerpt, terms: terms(excerpt) });
    if (end >= text.length) break;
  }
  return chunks;
}

const indexCache = new WeakMap();
function indexFor(source) {
  if (!source || typeof source !== 'object' || typeof source.text !== 'string' || !source.text.trim()) return null;
  let index = indexCache.get(source);
  if (!index) {
    index = { name: source.name, characters: source.text.length, chunks: chunkSource(source.text) };
    indexCache.set(source, index);
  }
  return index;
}

export function retrieveSource(source, queries, { limit = 6, excerptLimit = 11000 } = {}) {
  const index = indexFor(source);
  const requested = [...new Set((Array.isArray(queries) ? queries : [queries])
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].slice(0, 6);
  if (!index || requested.length === 0) return { name: source?.name ?? null, characters: index?.characters ?? 0, hits: [], queries: requested };
  const queryTerms = requested.flatMap(terms);
  const querySet = new Set(queryTerms);
  const ranked = index.chunks.map(chunk => {
    const overlap = chunk.terms.reduce((score, term) => score + (querySet.has(term) ? 1 : 0), 0);
    const phraseScore = requested.reduce((score, query) => score + (chunk.text.toLowerCase().includes(normalize(query)) ? 5 : 0), 0);
    return { chunk, score: overlap + phraseScore };
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start);
  const candidates = ranked.length ? ranked : index.chunks.slice(0, limit).map(chunk => ({ chunk, score: 0 }));
  const hits = [];
  let characters = 0;
  for (const { chunk, score } of candidates) {
    if (hits.length >= limit) break;
    const next = characters + chunk.text.length;
    if (hits.length && next > excerptLimit) continue;
    hits.push({ id: chunk.id, start: chunk.start, end: chunk.end, score, text: chunk.text });
    characters = next;
  }
  return { name: index.name, characters: index.characters, hits, queries: requested };
}

export function sourceContextText(context) {
  if (!context?.hits?.length) return '';
  return context.hits.map((hit, index) => `【素材片段 ${index + 1}｜${hit.start}-${hit.end}】\n${hit.text}`).join('\n\n');
}

export function sourceSearchTerms(...values) {
  return [...new Set(values.flatMap(value => terms(value)))].filter(term => CJK.test(term) || WORD.test(term)).slice(0, 40);
}
