import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { rolldown } from 'rolldown';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

for (const format of ['module', 'commonjs']) {
  test(`${format} import is safe in a fresh server process`, () => {
    const load =
      format === 'module'
        ? "const api = await import('marquee-content');"
        : "const api = require('marquee-content');";
    const source = `
      const assert = ${format === 'module' ? "(await import('node:assert/strict')).default" : "require('node:assert/strict')"};
      assert.equal(typeof globalThis.window, 'undefined');
      assert.equal(typeof globalThis.HTMLElement, 'undefined');
      ${load}
      assert.equal(typeof api.MarqueeContent, 'function');
      assert.throws(() => new api.MarqueeContent(), /browser/);
      api.defineMarqueeContent();
      api.initMarqueeContents();
      api.MarqueeContent.configureStyles({ styleOverrides: ':host { color: red; }' });
      assert.equal(typeof globalThis.window, 'undefined');
      assert.equal(typeof globalThis.HTMLElement, 'undefined');
    `;
    const result = spawnSync(process.execPath, [`--input-type=${format}`, '--eval', source], {
      cwd: packageRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

for (const [format, source] of [
  ['module', "import 'marquee-content';"],
  ['commonjs', "require('marquee-content');"],
]) {
  test(`production ${format} consumer preserves automatic registration`, async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), 'marquee-content-consumer-'));
    t.after(() => {
      assert.equal(dirname(fixture), tmpdir());
      assert.ok(basename(fixture).startsWith('marquee-content-consumer-'));
      rmSync(fixture, { recursive: true, force: true });
    });
    const installedPackage = join(fixture, 'node_modules', 'marquee-content');
    mkdirSync(installedPackage, { recursive: true });
    cpSync(join(packageRoot, 'package.json'), join(installedPackage, 'package.json'));
    cpSync(join(packageRoot, 'dist'), join(installedPackage, 'dist'), { recursive: true });
    const entry = join(fixture, format === 'module' ? 'consumer.mjs' : 'consumer.cjs');
    writeFileSync(entry, source);

    const build = await rolldown({ input: entry, platform: 'browser', treeshake: true });
    t.after(() => build.close());
    const { output } = await build.generate({ format: 'iife', minify: true });
    const script = output.find((item) => item.type === 'chunk' && item.isEntry);
    assert.ok(script, 'consumer bundle has an entry chunk');

    // Only registration is executed here; browser tests exercise the component itself.
    const registry = new Map();
    const customElements = {
      get: (name) => registry.get(name),
      define: (name, component) => registry.set(name, component),
    };
    class HTMLElement {}
    runInNewContext(script.code, {
      HTMLElement,
      customElements,
      window: { customElements },
    });
    const component = registry.get('marquee-content');
    assert.equal(
      typeof component,
      'function',
      'side-effect-only imports must register the element',
    );
    assert.ok(component.prototype instanceof HTMLElement);
  });
}
