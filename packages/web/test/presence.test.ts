import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatPanel } from '../src/presence/ChatPanel.js';
import { DigestPanel } from '../src/presence/DigestPanel.js';

describe('presence panels', () => {
  it('renders avatar choice, dialogue, and slowdown notice on the server', () => {
    const html = renderToString(React.createElement(ChatPanel, {
      characters: [{ id: 'ada', name: '阿苇' }, { id: 'bo', name: '老舟' }],
      selectedEntityId: 'ada', otherEntityId: 'bo', lines: [{ id: 'line1', speaker: '阿苇', text: '你好。' }],
      slowdownActive: true, onSelectAvatar: () => {}, onSend: () => {},
    }));
    expect(html).toContain('你的化身');
    expect(html).toContain('对话期间，世界以 1× 速度运行');
    expect(html).toContain('你好。');
  });

  it('renders digest broadcast items', () => {
    const html = renderToString(React.createElement(DigestPanel, { entries: [
      { revisionId: 'rev1', text: '渡口重新开放。', importance: 8.5, atMinutes: 42 },
    ] }));
    expect(html).toContain('世界近况');
    expect(html).toContain('渡口重新开放。');
    expect(html).toContain('重要度');
    expect(html).toContain('8.5');
  });
});
