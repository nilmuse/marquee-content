import { expect, type Locator, type Page, test } from '@playwright/test';

interface FixtureOptions {
  width?: number;
  gap?: number;
  mode?: 'auto' | 'scroll';
  direction?: 'rtl' | 'ltr';
  groupStyle?: string;
}

async function mountCopies(
  page: Page,
  content: string,
  { width = 1000, gap = 0, mode = 'auto', direction = 'rtl', groupStyle = '' }: FixtureOptions = {},
): Promise<Locator> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(customElements.get('marquee-content')));
  await page.addStyleTag({
    content: `
      #fixture { width: ${width}px; }
      marquee-content { --marquee-content-gap: ${gap}px; }
      marquee-content::part(group) { ${groupStyle} }
    `,
  });
  await page.locator('#fixture').evaluate((fixture, markup) => {
    fixture.innerHTML = markup;
  }, `<marquee-content mode="${mode}" direction="${direction}">${content}</marquee-content>`);
  const host = page.locator('marquee-content');
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  return host;
}

function fixedItems(widths: number[]): string {
  return widths
    .map(
      (width, index) =>
        `<span data-copy-item="${index}" style="width:${width}px;height:32px">${index}</span>`,
    )
    .join('');
}

function visualItems(host: Locator): Locator {
  return host.locator('[part~="track"] [data-copy-item]');
}

async function expectSeamlessPhases(host: Locator, sourceCount: number): Promise<void> {
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  const samples = await host.evaluate(async (element, count) => {
    const track = element.shadowRoot?.querySelector<HTMLElement>('[part~="track"]');
    const viewport = element.shadowRoot?.querySelector<HTMLElement>('[part~="viewport"]');
    const animation = track?.getAnimations()[0];
    if (!track || !viewport || !animation) throw new Error('Moving track is missing');
    animation.pause();
    await animation.ready;
    const distance = Number.parseFloat(
      element.style.getPropertyValue('--marquee-content-distance'),
    );
    const duration = Number(animation.effect?.getTiming().duration);
    const reversed = element.getAttribute('direction') === 'ltr';
    const results = [];

    for (const phase of [0, 0.25, 0.5, 0.75, 0.999999]) {
      animation.currentTime = duration * phase;
      await new Promise(requestAnimationFrame);
      const trackBounds = track.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      const items = Array.from(track.querySelectorAll<HTMLElement>('[data-copy-item]'));
      const rects = items.map((item) => item.getBoundingClientRect());
      let repeatError = 0;
      let widthError = 0;

      for (let index = count; index < rects.length; index += 1) {
        repeatError = Math.max(
          repeatError,
          Math.abs(rects[index].left - rects[index - count].left - distance),
        );
        widthError = Math.max(
          widthError,
          Math.abs(rects[index].width - rects[index - count].width),
        );
      }

      const translation = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      results.push({
        phase,
        leftUncovered: trackBounds.left - viewportBounds.left,
        rightUncovered: viewportBounds.right - trackBounds.right,
        translationError: Math.abs(translation + distance * (reversed ? 1 - phase : phase)),
        repeatError,
        widthError,
        identities: items.map((item) => item.dataset.copyItem),
      });
    }

    return { distance, samples: results };
  }, sourceCount);

  expect(samples.distance).toBeGreaterThan(0);
  for (const sample of samples.samples) {
    const context = `at animation phase ${sample.phase}`;
    // Coverage is the painted strip's extent, so the author's normal item gaps and group
    // padding remain valid space rather than being mistaken for a missing repetition.
    expect(sample.leftUncovered, context).toBeLessThanOrEqual(0.1);
    expect(sample.rightUncovered, context).toBeLessThanOrEqual(0.1);
    expect(sample.translationError, context).toBeLessThan(0.1);
    expect(sample.repeatError, context).toBeLessThan(0.1);
    expect(sample.widthError, context).toBeLessThan(0.1);
    expect(sample.identities, context).toEqual(
      sample.identities.map((_, index) => String(index % sourceCount)),
    );
  }
}

for (const scenario of [
  { name: 'one narrow item', widths: [100], gap: 0, expected: 11 },
  { name: 'one exactly container-wide item', widths: [1000], gap: 0, expected: 2 },
  { name: 'one slightly wider item', widths: [1005], gap: 0, expected: 2 },
  {
    name: 'a repeated four-item set with gaps',
    widths: [100, 100, 100, 100],
    gap: 25,
    expected: 12,
  },
]) {
  test(`only renders the required repeated content for ${scenario.name}`, async ({ page }) => {
    const host = await mountCopies(page, fixedItems(scenario.widths), { gap: scenario.gap });
    await expect(visualItems(host)).toHaveCount(scenario.expected);
    await expectSeamlessPhases(host, scenario.widths.length);
  });
}

for (const mode of ['auto', 'scroll'] as const) {
  for (const direction of ['rtl', 'ltr'] as const) {
    test(`${mode} ${direction} covers the viewport through fractional, decorated periods`, async ({
      page,
    }) => {
      const host = await mountCopies(page, fixedItems([83.125, 67.375, 101.75]), {
        width: 1000.25,
        gap: 13.625,
        mode,
        direction,
        groupStyle: 'padding-inline: 7.5px 19.375px; border-inline: 1px solid transparent;',
      });
      // A source set remains the animation period even when the author styles group boxes.
      const period = await host.evaluate((element) =>
        Number.parseFloat(element.style.getPropertyValue('--marquee-content-distance')),
      );
      expect(period).toBeGreaterThan(300);
      expect(period).toBeLessThan(320);
      await expect(visualItems(host)).toHaveCount((Math.ceil(1000.25 / period) + 1) * 3);
      await expectSeamlessPhases(host, 3);
    });
  }
}

test('adds and removes only the required copies after container resize', async ({ page }) => {
  const host = await mountCopies(page, fixedItems([100]), { width: 250 });
  await expect(visualItems(host)).toHaveCount(4);
  for (const [width, copies] of [
    [1000, 11],
    [200, 3],
    [1000, 11],
  ]) {
    await page.locator('#fixture').evaluate((fixture, nextWidth) => {
      fixture.style.width = `${nextWidth}px`;
    }, width);
    await expect(visualItems(host)).toHaveCount(copies);
    await expectSeamlessPhases(host, 1);
  }
});

test('reconciles copies when a fractional resize leaves clientWidth unchanged', async ({
  page,
}) => {
  const host = await mountCopies(page, fixedItems([100.11]), { width: 400.4 });
  await expect(host).toHaveJSProperty('clientWidth', 400);
  await expect(visualItems(host)).toHaveCount(5);
  await expectSeamlessPhases(host, 1);

  await page.locator('#fixture').evaluate((fixture) => {
    fixture.style.width = '400.49px';
  });
  await expect(host).toHaveJSProperty('clientWidth', 400);
  await expect(visualItems(host)).toHaveCount(6);
  await expectSeamlessPhases(host, 1);
});

test('clears a zero-width period and resumes when source content gains width', async ({ page }) => {
  const host = await mountCopies(page, fixedItems([100]));
  await expect(visualItems(host)).toHaveCount(11);
  await host.locator(':scope > span').evaluate((source) => {
    source.style.width = '0px';
  });
  await expect(host).not.toHaveAttribute('data-marquee-content-ready');
  await expect(visualItems(host)).toHaveCount(0);
  await expect
    .poll(() => host.locator('[part~="track"]').evaluate((track) => track.getAnimations().length))
    .toBe(0);

  await host.locator(':scope > span').evaluate((source) => {
    source.style.width = '100px';
  });
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  await expect(visualItems(host)).toHaveCount(11);
  await expectSeamlessPhases(host, 1);
});

test('recalculates the number of image copies when the intrinsic width changes', async ({
  page,
}) => {
  await page.route('**/copy-*.svg', (route) => {
    const width = /copy-(\d+)\.svg/.exec(route.request().url())?.[1];
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32"/>`,
    });
  });
  const host = await mountCopies(
    page,
    '<img data-copy-item="0" src="/copy-100.svg" alt="Resizable decorative image">',
  );
  await expect(visualItems(host)).toHaveCount(11);
  for (const [width, copies] of [
    [250, 5],
    [80, 14],
    [100, 11],
  ]) {
    await host.locator(':scope > img').evaluate(async (image, nextWidth) => {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          image.removeEventListener('load', onLoad);
          image.removeEventListener('error', onError);
        };
        const onLoad = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(`Failed to load /copy-${nextWidth}.svg`));
        };
        image.addEventListener('load', onLoad, { once: true });
        image.addEventListener('error', onError, { once: true });
        image.setAttribute('src', `/copy-${nextWidth}.svg`);
      });
      // The authored image's load can queue a second rebuild after cached clones
      // already have the expected count and width. Let that queued work run first.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }, width);
    await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
    await expect(visualItems(host)).toHaveCount(copies);
    await expect(visualItems(host).first()).toHaveCSS('width', `${width}px`);
    await expectSeamlessPhases(host, 1);
  }
});

test('reconciles a style change while asynchronous image copies are loading', async ({ page }) => {
  let release = () => {};
  const responseReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/copy-async.svg', async (route) => {
    await responseReady;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="32"/>',
    });
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(customElements.get('marquee-content')));
  await page.addStyleTag({
    content:
      '#fixture { width: 1000px; margin-top: 10000px; } marquee-content { --marquee-content-gap: 0px; }',
  });
  const request = page.waitForRequest('**/copy-async.svg');
  await page.locator('#fixture').evaluate((fixture) => {
    const style = document.createElement('style');
    style.textContent = 'marquee-content::part(item) { width: 200px; height: 32px; }';
    document.head.append(style);
    const element = document.createElement('marquee-content');
    element.innerHTML =
      '<img data-copy-item="0" src="/copy-async.svg" loading="lazy" alt="Deferred decorative image">';
    element.setAttribute('data-authored-loads', '0');
    element.querySelector('img')?.addEventListener('load', () => {
      element.setAttribute(
        'data-authored-loads',
        String(Number(element.getAttribute('data-authored-loads')) + 1),
      );
    });
    fixture.append(element);
    // Registered after the component's load handler: it can already have chosen the
    // copy count at 200px when this real image-load event changes each period to 80px.
    element.shadowRoot?.addEventListener(
      'load',
      () => {
        style.textContent = 'marquee-content::part(item) { width: 80px; height: 32px; }';
        element.setAttribute('data-copy-load-styled', 'true');
      },
      { capture: true, once: true },
    );
  });
  const host = page.locator('marquee-content');
  try {
    await request;
    await expect(host).not.toHaveAttribute('data-marquee-content-ready');
  } finally {
    release();
  }
  await expect(host).toHaveAttribute('data-copy-load-styled', 'true');
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  await expect(visualItems(host)).toHaveCount(14);
  await expect(visualItems(host).first()).toHaveCSS('width', '80px');
  await expect(host).toHaveAttribute('data-authored-loads', '0');
  await expect
    .poll(() =>
      visualItems(host).evaluateAll((items) =>
        items.every((item) => (item as HTMLImageElement).complete),
      ),
    )
    .toBe(true);
  await expectSeamlessPhases(host, 1);
  const replacements = await host.locator('[part~="track"]').evaluate(async (track) => {
    let records = 0;
    const observer = new MutationObserver((mutations) => {
      records += mutations.length;
    });
    observer.observe(track, { childList: true });
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    observer.disconnect();
    return records;
  });
  expect(replacements).toBe(0);
});
