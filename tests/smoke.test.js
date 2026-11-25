import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const expectedArtifacts = [
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.d.cts',
  'dist/marquee-content.css',
];

function assertMarqueeApi(api) {
  assert.equal(typeof api.defineMarqueeContent, 'function');
  assert.equal(typeof api.initMarqueeContents, 'function');
  assert.equal(typeof api.MarqueeContent, 'function');
  assert.equal(typeof api.marqueeContentCssText, 'string');
  assert.ok(api.marqueeContentCssText.length > 0);
}

test('dist artifacts exist', () => {
  for (const artifact of expectedArtifacts) {
    assert.equal(existsSync(artifact), true, `${artifact} should exist`);
  }
});

test('package ESM export imports in Node without DOM globals', async () => {
  assert.equal(typeof globalThis.HTMLElement, 'undefined');
  assertMarqueeApi(await import('marquee-content'));
});

test('package CommonJS export loads in Node without DOM globals', () => {
  assert.equal(typeof globalThis.HTMLElement, 'undefined');
  const requireFromTest = createRequire(import.meta.url);
  assertMarqueeApi(requireFromTest('marquee-content'));
});
