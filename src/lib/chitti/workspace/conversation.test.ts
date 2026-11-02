import { expect, it } from 'vitest';
import { conversationPath, conversationHeads } from './conversation';
it('shows just the selected branch and keeps old branches reachable in recent chats', () => {
  const parents = { b: 'a', c: 'b', fork: 'a', fresh: '' };
  expect(conversationPath('c', parents)).toEqual(['a', 'b', 'c']);
  expect(conversationPath('fork', parents)).toEqual(['a', 'fork']);
  expect(conversationHeads(['a', 'b', 'c', 'fork', 'fresh'], parents)).toEqual(['fresh', 'fork', 'c']);
  expect(conversationPath('a', { a: 'b', b: 'a' })).toEqual(['b', 'a']);
});
