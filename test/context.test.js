import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseContext } from '../src/context.js';

test('样例领域标识正确', async () => {
  const raw = await readFile(new URL('../fixtures/context.json', import.meta.url), 'utf8');
  const value = parseContext(raw);
  assert.equal(value.domain, 'renal-care-continuity');
  assert.ok(value.facts.length > 0);
});
