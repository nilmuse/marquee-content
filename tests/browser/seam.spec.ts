import { expect, type Locator, type Page, test } from '@playwright/test';

test.use({ deviceScaleFactor: 3 });

async function expectPaintedStrip(page: Page, host: Locator): Promise<void> {
  // Use pixels from a running animation, without a screenshot baseline or pausing it.
  // The solid item background must cover the strip even when a repeat crosses the seam.
  const image = await host.screenshot({ animations: 'allow' });
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Screenshot decoding context is missing');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, canvas.height - 6, canvas.width, 1);
    let painted = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] === 12 && data[index + 1] === 140 && data[index + 2] === 72) {
        painted += 1;
      }
    }
    return { painted, width: canvas.width };
  }, image.toString('base64'));
  expect(pixels.width).toBe(393 * 3);
  expect(pixels.painted / pixels.width).toBeGreaterThan(0.99);
}

for (const mode of ['auto', 'scroll'] as const) {
  for (const direction of ['rtl', 'ltr'] as const) {
    test(`mobile ${mode} ${direction} stays covered through live animation seams`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 393, height: 852 });
      await page.goto('/');
      await page.waitForFunction(() => Boolean(customElements.get('marquee-content')));
      await page.addStyleTag({
        content: `
          #fixture { width: 393px; margin: 24px 0; }
          marquee-content { --marquee-content-gap: 0px; background: white; }
          marquee-content::part(item) {
            display: block;
            width: 720px;
            height: 48px;
            background: rgb(12, 140, 72);
            color: white;
            font: 24px/32px Arial, sans-serif;
          }
        `,
      });
      await page.locator('#fixture').evaluate((fixture, markup) => {
        fixture.innerHTML = markup;
      }, `<marquee-content mode="${mode}" direction="${direction}" speed="500"><span>Continuous mobile marquee</span></marquee-content>`);
      const host = page.locator('marquee-content');
      const track = host.locator('[part~="track"]');
      await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
      await host.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      await expect
        .poll(() => track.evaluate((element) => element.getAnimations()[0]?.playState))
        .toBe('running');

      // At DPR 3 the 1440 CSS-pixel track spans 4320 device pixels. This exercises a
      // wide moving layer on a narrow viewport; desktop WebKit is not iPhone CoreAnimation.
      const initial = await track.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        dpr: devicePixelRatio,
      }));
      expect(initial.width).toBeGreaterThan(1280);
      expect(initial.dpr).toBe(3);

      const coverage = track.evaluate(async (element) => {
        const viewport = element.parentElement;
        const animation = element.getAnimations()[0];
        if (!viewport || !animation) throw new Error('Running marquee is missing');
        await animation.ready;
        const firstIteration = animation.effect?.getComputedTiming().currentIteration;
        if (firstIteration == null) throw new Error('Animation iteration is missing');
        const firstChildren = Array.from(element.children);
        let mutations = 0;
        let samples = 0;
        let seams = 0;
        let previousIteration = firstIteration;
        let maxUncovered = 0;
        let stableAnimation = true;
        const observer = new MutationObserver((records) => {
          mutations += records.length;
        });
        observer.observe(element, { childList: true, subtree: true });
        const startedAt = performance.now();

        try {
          while (seams < 3 && performance.now() - startedAt < 10_000) {
            await new Promise(requestAnimationFrame);
            const strip = element.getBoundingClientRect();
            const clip = viewport.getBoundingClientRect();
            maxUncovered = Math.max(maxUncovered, strip.left - clip.left, clip.right - strip.right);
            samples += 1;
            stableAnimation &&= element.getAnimations()[0] === animation;
            const iteration = animation.effect?.getComputedTiming().currentIteration;
            if (iteration != null && iteration > previousIteration) {
              seams += iteration - previousIteration;
              previousIteration = iteration;
            }
          }
        } finally {
          observer.disconnect();
        }

        return {
          seams,
          samples,
          maxUncovered,
          mutations,
          stableAnimation,
          stableChildren:
            firstChildren.length === element.children.length &&
            firstChildren.every((child, index) => element.children[index] === child),
          playState: animation.playState,
        };
      });

      // Watch the live clock approach a boundary, then capture both sides without
      // assigning currentTime or introducing the pause/ready race of a seeked test.
      await expect
        .poll(
          () =>
            track.evaluate((element, reversed) => {
              const progress = element.getAnimations()[0]?.effect?.getComputedTiming().progress;
              return (
                progress != null &&
                (reversed ? progress > 0.2 && progress < 0.3 : progress > 0.7 && progress < 0.8)
              );
            }, direction === 'ltr'),
          { intervals: [16], timeout: 5000 },
        )
        .toBe(true);
      const beforeIteration = await track.evaluate(
        (element) => element.getAnimations()[0].effect?.getComputedTiming().currentIteration ?? -1,
      );
      await expectPaintedStrip(page, host);
      await expect
        .poll(
          () =>
            track.evaluate(
              (element) =>
                element.getAnimations()[0].effect?.getComputedTiming().currentIteration ?? -1,
            ),
          { intervals: [16], timeout: 5000 },
        )
        .toBeGreaterThan(beforeIteration);
      await expectPaintedStrip(page, host);

      const result = await coverage;
      expect(result.seams).toBeGreaterThanOrEqual(3);
      expect(result.samples).toBeGreaterThan(30);
      expect(result.maxUncovered).toBeLessThanOrEqual(0.1);
      expect(result.mutations).toBe(0);
      expect(result.stableAnimation).toBe(true);
      expect(result.stableChildren).toBe(true);
      expect(result.playState).toBe('running');
    });
  }
}
