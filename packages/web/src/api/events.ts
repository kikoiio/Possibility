import type { SseEvent, StateSnapshot } from '@wispiva/contract';

const eventTypes = new Set<SseEvent['type']>(['snapshot', 'line', 'revision', 'call']);

function toSseEvent(eventName: string | undefined, data: string): SseEvent | undefined {
  const value: unknown = JSON.parse(data);
  if (typeof value === 'object' && value !== null && 'type' in value && 'data' in value) {
    const candidate = value as SseEvent;
    return eventTypes.has(candidate.type) ? candidate : undefined;
  }
  if (eventName === undefined || !eventTypes.has(eventName as SseEvent['type'])) return undefined;
  return { type: eventName as SseEvent['type'], data: value } as SseEvent;
}

function parseBlock(block: string): SseEvent | undefined {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/u)) {
    if (line === '' || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'event') eventName = value;
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return toSseEvent(eventName, data.join('\n'));
}

export function parseSseChunks(chunks: Iterable<string>): SseEvent[] {
  const events: SseEvent[] = [];
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const event = parseBlock(block);
      if (event !== undefined) events.push(event);
    }
  }
  if (buffer.trim() !== '') {
    const event = parseBlock(buffer);
    if (event !== undefined) events.push(event);
  }
  return events;
}

export async function reconnectEvents(
  getState: () => Promise<StateSnapshot>,
  incrementalChunks: Iterable<string>,
): Promise<SseEvent[]> {
  const snapshot = await getState();
  return [{ type: 'snapshot', data: snapshot }, ...parseSseChunks(incrementalChunks)];
}
