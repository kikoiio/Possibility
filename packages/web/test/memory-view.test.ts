import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Memory } from '@wispiva/contract';
import { MemoryPanel } from '../src/memory-view/index.js';

const memories: Memory[] = [
  { id: 'm1', owner: '阿苇', text: '我仍怕那场火。', valence: -0.8, intensity: 0.9, importance: 8, about: ['书院'] },
  { id: 'm2', owner: '老舟', text: '我想守住旧秘密。', valence: 0.6, intensity: 0.5, importance: 6, about: ['书院'] },
];

describe('memory comparison panel', () => {
  it('renders facts, owner-separated L1 rows with valence colors, and L2 tellings', () => {
    const html = renderToString(React.createElement(MemoryPanel, {
      eventText: '书院旧档被翻出。', memories,
      reflections: [{ owner: '阿苇', text: '我如今说那只是意外。' }, { owner: '老舟', text: '我当年只是在保护大家。' }],
    }));
    expect(html).toContain('书院旧档被翻出。');
    expect(html).toContain('data-owner="阿苇"');
    expect(html).toContain('data-owner="老舟"');
    expect(html).toContain('class="valence-negative"');
    expect(html).toContain('class="valence-positive"');
    expect(html).toContain('我如今说那只是意外。');
  });
});
