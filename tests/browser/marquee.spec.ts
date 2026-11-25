import { expect, type Locator, type Page, test } from '@playwright/test';
import type * as MarqueeApi from '../../src/index';
import type { MarqueeContent } from '../../src/marquee-content';

declare global {
  interface Window {
    marqueeApi: typeof MarqueeApi;
    requestedFrames: number;
  }
}

const words = '<span part="presto">Presto</span><span part="tempo">Tempo</span>';

async function mount(page: Page, content = words, attributes = ''): Promise<Locator> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.marqueeApi));
  await page.locator('#fixture').evaluate((fixture, markup) => {
    fixture.innerHTML = markup;
  }, `<marquee-content ${attributes}>${content}</marquee-content>`);
  const host = page.locator('marquee-content');
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  return host;
}

async function expectMatchingDistance(host: Locator): Promise<void> {
  await expect
    .poll(() =>
      host.evaluate((element) => {
        const group = element.shadowRoot?.querySelector('[part~="group"]');
        const distance = Number.parseFloat(
          element.style.getPropertyValue('--marquee-content-distance'),
        );
        return group ? Math.abs(group.getBoundingClientRect().width - distance) : Infinity;
      }),
    )
    .toBeLessThan(1.1);
}

async function renderedReplacements(host: Locator, duration = 350): Promise<number> {
  return host.evaluate(async (element, observationMs) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Rendered track is missing');
    let replacements = 0;
    const observer = new MutationObserver((records) => {
      replacements += records.length;
    });
    observer.observe(track, { childList: true });
    await new Promise((resolve) => window.setTimeout(resolve, observationMs));
    observer.disconnect();
    return replacements;
  }, duration);
}

test('preserves author parts and inherited decorative typography', async ({ page }) => {
  const host = await mount(page);
  await page.addStyleTag({
    content: `
    marquee-content { font-size: 32px; font-weight: 600; text-transform: uppercase; }
    marquee-content::part(presto) { color: rgb(230, 57, 70); font-weight: 900; }
    marquee-content::part(tempo) { color: rgb(69, 123, 157); font-weight: 100; }
  `,
  });

  const presto = host.locator('[part~="track"] [part~="presto"]').first();
  await expect(presto).toHaveCSS('color', 'rgb(230, 57, 70)');
  await expect(presto).toHaveCSS('font-weight', '900');
  await expect(presto).toHaveCSS('font-size', '32px');
  await expect(presto).toHaveCSS('text-transform', 'uppercase');
  await expect(host.locator('[part~="track"] [part~="tempo"]').first()).toHaveCSS(
    'font-weight',
    '100',
  );
  await expectMatchingDistance(host);
});

test('image loading settles instead of continually replacing rendered groups', async ({ page }) => {
  await page.route('**/logo.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60"><rect width="180" height="60" fill="red"/></svg>',
    }),
  );
  const host = await mount(page, '<img src="/logo.svg" alt="Example brand">');
  await expect
    .poll(() =>
      host
        .locator('img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  // Observe an entire interval: an immediate assertion would miss repeated cached-image loads.
  await expect.poll(() => renderedReplacements(host)).toBe(0);
  await expectMatchingDistance(host);
});

test('measures lazy image copies offscreen without overriding CSS aspect ratio', async ({
  page,
}) => {
  await page.route('**/lazy-logo.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60"/>',
    }),
  );
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent =
        '#fixture { margin-top: 10000px; } marquee-content::part(logo) { height: 30px; width: auto; }';
      document.head.append(style);
    });
  });
  const host = await mount(
    page,
    '<img src="/lazy-logo.svg" part="logo" loading="lazy" alt="Lazy brand">',
  );
  const copy = host.locator('[part~="track"] img').first();
  await expect(copy).toHaveCSS('width', '90px');
  await expect(copy).toHaveCSS('height', '30px');
  await expect(host.locator(':scope > img')).toHaveAttribute('loading', 'lazy');
  await expectMatchingDistance(host);
  const groupWidth = await host
    .locator('[part~="group"]')
    .first()
    .evaluate((group) => group.getBoundingClientRect().width);
  expect(groupWidth).toBeGreaterThanOrEqual(400);
  expect(groupWidth).toBeLessThan(800);
  await expect.poll(() => renderedReplacements(host)).toBe(0);
});

test('failed images finish layout without repeated reconstruction', async ({ page }) => {
  await page.route('**/missing-logo.svg', (route) => route.fulfill({ status: 404, body: '' }));
  const host = await mount(page, '<img src="/missing-logo.svg" alt="Unavailable brand">');
  await expect
    .poll(() =>
      host
        .locator('[part~="track"] img')
        .evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete)),
    )
    .toBe(true);
  await expectMatchingDistance(host);
  await expect.poll(() => renderedReplacements(host)).toBe(0);
});

test('pending image loads cannot finish layout after the element is removed', async ({ page }) => {
  let release = () => {};
  const responseReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/slow-logo.svg', async (route) => {
    await responseReady;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60"/>',
    });
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.marqueeApi));
  const request = page.waitForRequest('**/slow-logo.svg');
  await page.locator('#fixture').evaluate((fixture) => {
    fixture.innerHTML =
      '<marquee-content><img src="/slow-logo.svg" alt="Slow brand"></marquee-content>';
  });
  await request;
  const host = page.locator('marquee-content');
  const element = await host.elementHandle();
  if (!element) throw new Error('Source component is missing');
  try {
    await expect(host).not.toHaveAttribute('data-marquee-content-ready', 'true');
    await element.evaluate((node) => node.remove());
  } finally {
    release();
  }
  await expect
    .poll(() =>
      element.evaluate((node) => (node.querySelector('img') as HTMLImageElement).complete),
    )
    .toBe(true);
  const state = await element.evaluate(async (node) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const track = node.shadowRoot?.querySelector('[part~="track"]');
    return {
      ready: node.hasAttribute('data-marquee-content-ready'),
      items: track?.childElementCount,
      animations: track?.getAnimations().length,
    };
  });
  expect(state).toEqual({ ready: false, items: 0, animations: 0 });
});

test('recalculates after an image source changes its intrinsic size', async ({ page }) => {
  await page.route('**/logo-*.svg', (route) => {
    const width = route.request().url().includes('wide') ? 300 : 75;
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="40"><rect width="${width}" height="40" fill="blue"/></svg>`,
    });
  });
  const host = await mount(page, '<img src="/logo-small.svg" alt="Resizable brand">');
  await expect
    .poll(() =>
      host
        .locator('[part~="track"] img')
        .first()
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(75);
  await host.evaluate((element) => {
    const image = element.querySelector('img');
    if (!image) throw new Error('Source image is missing');
    image.src = '/logo-wide.svg';
  });
  await expect
    .poll(() =>
      host
        .locator('[part~="track"] img')
        .first()
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(300);
  await expectMatchingDistance(host);
  await expect.poll(() => renderedReplacements(host)).toBe(0);
});

test('keeps the seam aligned after style overrides, CSS variables and part resizing', async ({
  page,
}) => {
  const host = await mount(page);
  await page.evaluate(() => {
    window.marqueeApi.MarqueeContent.setStyleOverrides(
      '.marquee-content__group { gap: 90px; padding-inline-end: 90px; }',
    );
  });
  await expect(host.locator('[part~="group"]').first()).toHaveCSS('column-gap', '90px');
  await expectMatchingDistance(host);

  await page.evaluate(() => window.marqueeApi.MarqueeContent.setStyleOverrides(null));
  await host.evaluate((element) => element.style.setProperty('--marquee-content-gap', '56px'));
  await expect(host.locator('[part~="group"]').first()).toHaveCSS('column-gap', '56px');
  await expectMatchingDistance(host);

  await page.addStyleTag({ content: 'marquee-content::part(presto) { font-size: 80px; }' });
  await expect(host.locator('[part~="track"] [part~="presto"]').first()).toHaveCSS(
    'font-size',
    '80px',
  );
  await expectMatchingDistance(host);
  await expect.poll(() => renderedReplacements(host)).toBe(0);
});

test('responsive speed defaults on and can be changed through every public option form', async ({
  page,
}) => {
  const host = await mount(page, words, 'speed="100"');
  const speed = () =>
    host.evaluate((element) => {
      const distance = Number.parseFloat(
        element.style.getPropertyValue('--marquee-content-distance'),
      );
      const duration = Number.parseFloat(
        element.style.getPropertyValue('--marquee-content-duration'),
      );
      return distance / duration;
    });
  await expect.poll(speed).toBeCloseTo(55, 2);
  await expect
    .poll(() => host.evaluate((element) => (element as MarqueeContent).responsiveSpeed))
    .toBe(true);

  await host.evaluate((element) => element.setAttribute('responsive-speed', 'false'));
  await expect.poll(speed).toBeCloseTo(100, 2);
  await expect
    .poll(() => host.evaluate((element) => (element as MarqueeContent).responsiveSpeed))
    .toBe(false);

  await host.evaluate((element) => {
    (element as MarqueeContent).responsiveSpeed = true;
  });
  await expect.poll(speed).toBeCloseTo(55, 2);
  await host.evaluate((element) => {
    (element as MarqueeContent).update({ responsiveSpeed: false });
  });
  await expect.poll(speed).toBeCloseTo(100, 2);
  await host.evaluate((element) => {
    (element as MarqueeContent).responsiveSpeed = null;
  });
  await expect.poll(speed).toBeCloseTo(55, 2);
});

test('option changes update movement without replacing decorative content', async ({ page }) => {
  const host = await mount(page);
  const replacements = await host.evaluate(async (element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Rendered track is missing');
    let replacements = 0;
    const observer = new MutationObserver((records) => {
      replacements += records.length;
    });
    observer.observe(track, { childList: true });
    (element as MarqueeContent).update({ speed: 120, direction: 'ltr', responsiveSpeed: false });
    (element as MarqueeContent).mode = 'scroll';
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    observer.disconnect();
    return replacements;
  });
  expect(replacements).toBe(0);
  await expect(host).toHaveAttribute('data-marquee-content-mode', 'scroll');
  await expect
    .poll(() =>
      host.locator('[part~="track"]').evaluate((track) => track.getAnimations()[0]?.playState),
    )
    .toBe('running');
});

test('registers an additional custom tag after the default automatic registration', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.marqueeApi));
  await page.evaluate(() => {
    window.marqueeApi.defineMarqueeContent('brand-marquee');
    window.marqueeApi.defineMarqueeContent('brand-marquee');
    const fixture = document.getElementById('fixture');
    if (!fixture) throw new Error('Fixture is missing');
    fixture.innerHTML = '<brand-marquee><span part="brand">Custom tag</span></brand-marquee>';
  });
  const host = page.locator('brand-marquee');
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  await expect(host.locator('[part~="track"] [part~="brand"]').first()).toHaveText('Custom tag');
  await expectMatchingDistance(host);
});

test('preserves the visible phase when speed, direction and mode change', async ({ page }) => {
  const host = await mount(page, words, 'pause-on-hover');
  await host.hover();
  const track = host.locator('[part~="track"]');
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe('paused');
  const samples = await host.evaluate(async (element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Rendered track is missing');
    const first = track.getAnimations()[0];
    await first.ready;
    first.currentTime = Number(first.effect?.getTiming().duration) * 0.25;
    const sample = async () => {
      const animation = track.getAnimations()[0];
      await animation.ready;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        progress: animation.effect?.getComputedTiming().progress,
        offset: new DOMMatrixReadOnly(getComputedStyle(track).transform).m41,
      };
    };
    const samples = [await sample()];
    const host = element as MarqueeContent;
    host.update({ speed: 140, responsiveSpeed: false });
    samples.push(await sample());
    host.direction = 'ltr';
    samples.push(await sample());
    host.mode = 'scroll';
    samples.push(await sample());
    host.mode = 'auto';
    samples.push(await sample());
    return samples;
  });
  for (const sample of samples) {
    expect(sample.progress).toBeCloseTo(0.25, 5);
    expect(sample.offset).toBeCloseTo(samples[0].offset, 2);
  }
});

test('observes an initially empty text node when it receives content', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.marqueeApi));
  await page.locator('#fixture').evaluate((fixture) => {
    fixture.innerHTML = '<marquee-content>   </marquee-content>';
  });
  const host = page.locator('marquee-content');
  await expect(host).not.toHaveAttribute('data-marquee-content-ready');
  await host.evaluate((element) => {
    if (!element.firstChild) throw new Error('Source text node is missing');
    element.firstChild.textContent = 'New decorative text';
  });
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  await expect(host.locator('[part~="track"]')).toContainText('New decorative text');
  await expectMatchingDistance(host);
});

test('reduced motion shows each unique item once and fits all content in the host', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const content = ['Presto', 'Tempo', 'Vomero', 'Pegasus', 'Cortez', 'Air Max']
    .map((word) => `<span part="brand">${word}</span>`)
    .join('');
  const host = await mount(page, content);
  await page.addStyleTag({ content: 'marquee-content::part(brand) { font-size: 48px; }' });
  await expect(host.locator('[part~="track"] [part~="brand"]')).toHaveCount(6);
  await expect
    .poll(() =>
      host.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const items = Array.from(element.shadowRoot?.querySelectorAll('[part~="brand"]') ?? []);
        return items.every((item) => {
          const rect = item.getBoundingClientRect();
          return (
            rect.left >= bounds.left - 1 &&
            rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 &&
            rect.bottom <= bounds.bottom + 1
          );
        });
      }),
    )
    .toBe(true);
  await expect
    .poll(() => host.locator('[part~="track"]').evaluate((track) => track.getAnimations().length))
    .toBe(0);
  await expect(host).toMatchAriaSnapshot(`
    - text: Presto Tempo Vomero Pegasus Cortez Air Max
  `);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect
    .poll(() => host.locator('[part~="track"]').evaluate((track) => track.getAnimations().length))
    .toBe(1);
  await expectMatchingDistance(host);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(host.locator('[part~="track"] [part~="brand"]')).toHaveCount(6);
});

test('decorative copies cannot receive keyboard focus', async ({ page }) => {
  const host = await mount(page, '<span part="brand" tabindex="0">Focusable source</span>');
  await page.locator('#fixture').evaluate((fixture) => {
    const after = document.createElement('button');
    after.textContent = 'After marquee';
    fixture.append(after);
  });
  await expect(host.locator('[part~="track"]')).toHaveAttribute('aria-hidden', 'true');
  await expect(host.locator('[part~="track"]')).toHaveAttribute('inert', '');
  await page.keyboard.press('Tab');
  await expect(host.locator(':scope > span')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'After marquee' })).toBeFocused();
});

test('updates source text and survives container resize and reconnection', async ({ page }) => {
  const host = await mount(page);
  await host.evaluate((element) => {
    const first = element.firstElementChild;
    if (!first) throw new Error('Source item is missing');
    first.textContent = 'Updated decorative text';
  });
  await expect(host.locator('[part~="track"] [part~="presto"]').first()).toHaveText(
    'Updated decorative text',
  );
  await page.locator('#fixture').evaluate((fixture) => {
    fixture.style.width = '780px';
  });
  await expect(host).toHaveCSS('width', '780px');
  await expectMatchingDistance(host);

  const disconnected = await host.evaluate(async (element) => {
    const parent = element.parentElement;
    if (!parent) throw new Error('Fixture is missing');
    element.remove();
    const state = {
      ready: element.hasAttribute('data-marquee-content-ready'),
      animations: element.shadowRoot?.querySelector('[part~="track"]')?.getAnimations().length,
    };
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    window.marqueeApi.MarqueeContent.setStyleOverrides(
      '.marquee-content__group { gap: 88px; padding-inline-end: 88px; }',
    );
    parent.append(element);
    return state;
  });
  expect(disconnected).toEqual({ ready: false, animations: 0 });
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  await expect(host.locator('[part~="track"] [part~="presto"]').first()).toHaveText(
    'Updated decorative text',
  );
  await expect(host.locator('[part~="group"]').first()).toHaveCSS('column-gap', '88px');
  await expectMatchingDistance(host);
  await expect.poll(() => renderedReplacements(host)).toBe(0);
});

for (const mode of ['auto', 'scroll']) {
  test(`${mode} keeps moving without a continuous JavaScript frame loop while idle`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.requestedFrames = 0;
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        window.requestedFrames += 1;
        return requestFrame(callback);
      };
    });
    const host = await mount(page, words, `mode="${mode}"`);
    const track = host.locator('[part~="track"]');
    await expect
      .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
      .toBe('running');
    await expect
      .poll(async () => {
        const before = await page.evaluate(() => window.requestedFrames);
        await page.waitForTimeout(200);
        return (await page.evaluate(() => window.requestedFrames)) - before;
      })
      .toBe(0);
    const timeBefore = await track.evaluate((element) =>
      Number(element.getAnimations()[0]?.currentTime),
    );
    await page.waitForTimeout(100);
    const timeAfter = await track.evaluate((element) =>
      Number(element.getAnimations()[0]?.currentTime),
    );
    expect(timeAfter).not.toBe(timeBefore);
  });
}

test('scroll movement in the reverse direction keeps running across the old zero-time boundary', async ({
  page,
}) => {
  const host = await mount(page, words, 'mode="scroll" direction="ltr"');
  const track = host.locator('[part~="track"]');
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe('running');
  // Starting close to zero simulates exhausting the former finite reverse-playback seed.
  const timing = await track.evaluate((element) => {
    const animation = element.getAnimations()[0];
    return { direction: animation.effect?.getTiming().direction, rate: animation.playbackRate };
  });
  expect(timing.direction).toBe('reverse');
  expect(timing.rate).toBeGreaterThan(0);
  await track.evaluate((element) => {
    element.getAnimations()[0].currentTime = 1;
  });
  await page.waitForTimeout(150);
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe('running');
  const before = await track.evaluate((element) => getComputedStyle(element).transform);
  await page.waitForTimeout(100);
  const after = await track.evaluate((element) => getComputedStyle(element).transform);
  expect(after).not.toBe(before);

  const longRun = await track.evaluate(async (element) => {
    const animation = element.getAnimations()[0];
    animation.pause();
    await animation.ready;
    // CSS and native durations are quantized differently across engines. Ten thousand cycles
    // exceed the old 500-cycle budget without magnifying sub-nanosecond period rounding.
    const duration =
      Number.parseFloat(getComputedStyle(element).getPropertyValue('--marquee-content-duration')) *
      1000;
    animation.currentTime = duration * 0.25;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const initial = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
    const initialProgress = animation.effect?.getComputedTiming().progress;
    animation.currentTime = duration * (10_000 + 0.25);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const later = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
    const laterProgress = animation.effect?.getComputedTiming().progress;
    animation.play();
    return { initial, later, initialProgress, laterProgress };
  });
  expect(longRun.later).toBeCloseTo(longRun.initial, 2);
  expect(longRun.laterProgress).toBeCloseTo(longRun.initialProgress ?? 0, 5);
});

test('scroll events change direction and boost speed before settling without a frame loop', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.requestedFrames = 0;
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      window.requestedFrames += 1;
      return requestFrame(callback);
    };
  });
  const host = await mount(page, words, 'mode="scroll"');
  await page.addStyleTag({
    content: `
    body { min-height: 3000px; }
    marquee-content { position: fixed; width: 400px; top: 24px; left: 24px; }
  `,
  });
  const track = host.locator('[part~="track"]');
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playbackRate))
    .toBeGreaterThan(1.1);
  await page.evaluate(() => window.scrollTo(0, 100));
  await expect
    .poll(() =>
      track.evaluate((element) => element.getAnimations()[0]?.effect?.getTiming().direction),
    )
    .toBe('reverse');
  await expect
    .poll(
      async () => {
        const before = await page.evaluate(() => window.requestedFrames);
        await page.waitForTimeout(150);
        return (await page.evaluate(() => window.requestedFrames)) - before;
      },
      { timeout: 7000 },
    )
    .toBe(0);
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playbackRate))
    .toBeCloseTo(1, 2);
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe('running');
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect
    .poll(() =>
      track.evaluate((element) => element.getAnimations()[0]?.effect?.getTiming().direction),
    )
    .toBe('normal');
});

test('pauses outside the viewport and resumes when visible again', async ({ page }) => {
  const host = await mount(page);
  await page.addStyleTag({ content: 'body { min-height: 3000px; }' });
  const track = host.locator('[part~="track"]');
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe('running');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe('paused');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe('running');
});
