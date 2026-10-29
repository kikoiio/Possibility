const MAX_FRAME = 1024 * 1024;

// Incremental SSE framing, including UTF-8-decoded chunks split at CRLF.
export function createEventParser(onEvent) {
  let buffer = '';
  let data = [];
  let size = 0;
  let event = 'message';
  function line(value) {
    if (!value) {
      if (data.length) onEvent({ event, data: data.join('\n') });
      data = []; size = 0; event = 'message';
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const name = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (name === 'event') event = content;
    if (name === 'data') {
      size += content.length;
      if (size > MAX_FRAME) throw new Error('SSE frame too large');
      data.push(content);
    }
  }
  function push(chunk, ended = false) {
    buffer += chunk;
    while (true) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match || (!ended && match[0] === '\r' && match.index === buffer.length - 1)) break;
      line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (buffer.length > MAX_FRAME) throw new Error('SSE frame too large');
    if (ended) { if (buffer) line(buffer); buffer = ''; line(''); }
  }
  return { push, end() { push('', true); } };
}
