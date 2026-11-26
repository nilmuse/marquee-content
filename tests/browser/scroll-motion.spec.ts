import { expect, type Locator, type Page, test } from '@playwright/test';
import type { MarqueeContent } from '../../src/marquee-content';

declare global {
  interface Window {
    scrollAnimationCalls: { play: number; rate: number };
  }
}

async function mountScroll(page: Page, attributes = ''): Promise<Locator> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(customElements.get('marquee-content')));
  await page.addStyleTag({
    content: `
      body { min-height: 4000px; }
      marquee-content { position: fixed; top: 24px; left: 24px; width: 393px; }
      marquee-content::part(item) { display: block; width: 800px; height: 48px; }
    `,
  });
  await page.locator('#fixture').evaluate((fixture, markup) => {
    fixture.innerHTML = markup;
  }, `<marquee-content mode="scroll" ${attributes}><span>Continuous scroll motion</span></marquee-content>`);
  const host = page.locator('marquee-content');
  await expect(host).toHaveAttribute('data-marquee-content-ready', 'true');
  await host.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  return host;
}

async function movement(host: Locator): Promise<number> {
  return host.evaluate(async (element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    const distance = Number.parseFloat(
      element.style.getPropertyValue('--marquee-content-distance'),
    );
    let previous = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    let displacement = 0;
    const startedAt = performance.now();
    while (performance.now() - startedAt < 150) {
      await new Promise(requestAnimationFrame);
      const current = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      const delta = current - previous;
      displacement += delta - Math.round(delta / distance) * distance;
      previous = current;
    }
    return displacement / ((performance.now() - startedAt) / 1000);
  });
}

test('repeated scroll input avoids per-frame Web Animations timing mutations', async ({ page }) => {
  await page.addInitScript(() => {
    window.scrollAnimationCalls = { play: 0, rate: 0 };
    const isTrack = (animation: Animation): boolean => {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      return target instanceof HTMLElement && target.getAttribute('part') === 'track';
    };
    const play = Animation.prototype.play;
    Animation.prototype.play = function () {
      if (isTrack(this)) window.scrollAnimationCalls.play += 1;
      return play.call(this);
    };
    const updateRate = Animation.prototype.updatePlaybackRate;
    Animation.prototype.updatePlaybackRate = function (rate) {
      if (isTrack(this)) window.scrollAnimationCalls.rate += 1;
      return updateRate.call(this, rate);
    };
  });
  const host = await mountScroll(page);
  await page.evaluate(async () => {
    window.scrollAnimationCalls = { play: 0, rate: 0 };
    for (let index = 0; index < 24; index += 1) {
      window.scrollTo(0, 300 + index * 12);
      await new Promise(requestAnimationFrame);
    }
  });
  await expect.poll(() => movement(host)).toBeLessThan(-100);
  const calls = await page.evaluate(() => window.scrollAnimationCalls);
  expect(calls.rate).toBe(0);
  expect(calls.play).toBeLessThanOrEqual(1);
});

test('boost decays into native idle motion without a visible phase jump or coverage gap', async ({
  page,
}) => {
  const host = await mountScroll(page);
  const result = await host.evaluate(async (element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    const viewport = element.shadowRoot?.querySelector('[part~="viewport"]');
    if (!track || !viewport) throw new Error('Moving track is missing');
    const distance = Number.parseFloat(
      element.style.getPropertyValue('--marquee-content-distance'),
    );
    const duration = Number.parseFloat(
      element.style.getPropertyValue('--marquee-content-duration'),
    );
    const baseSpeed = distance / duration;
    const speeds: { time: number; speed: number }[] = [];
    let previous = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    let previousTime = performance.now();
    const startedAt = previousTime;
    let manualMotion = false;
    let resumedAt = 0;
    let maxJump = 0;
    let maxUncovered = 0;
    window.scrollTo(0, 500);

    while (performance.now() - startedAt < 6000) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      const current = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      const delta = current - previous;
      const displacement = delta - Math.round(delta / distance) * distance;
      const elapsed = (now - previousTime) / 1000;
      if (elapsed > 0) {
        maxJump = Math.max(maxJump, Math.abs(displacement) - baseSpeed * 6 * elapsed);
        speeds.push({ time: now - startedAt, speed: -displacement / elapsed });
      }
      const bounds = track.getBoundingClientRect();
      const visible = viewport.getBoundingClientRect();
      maxUncovered = Math.max(
        maxUncovered,
        bounds.left - visible.left,
        visible.right - bounds.right,
      );
      const nativeMotion = track
        .getAnimations()
        .some((animation) => animation.playState === 'running');
      if (!nativeMotion) manualMotion = true;
      if (manualMotion && nativeMotion && resumedAt === 0) resumedAt = now;
      previous = current;
      previousTime = now;
      if (resumedAt > 0 && now - resumedAt > 250) break;
    }

    const early = speeds.filter((sample) => sample.time > 100 && sample.time < 450);
    const late = speeds.slice(-8);
    const mean = (samples: typeof speeds): number =>
      samples.reduce((sum, sample) => sum + sample.speed, 0) / samples.length;
    return {
      manualMotion,
      resumed: resumedAt > 0,
      maxJump,
      maxUncovered,
      baseSpeed,
      earlySpeed: mean(early),
      lateSpeed: mean(late),
    };
  });
  expect(result.manualMotion).toBe(true);
  expect(result.resumed).toBe(true);
  expect(result.earlySpeed).toBeGreaterThan(result.baseSpeed * 1.5);
  expect(result.lateSpeed).toBeGreaterThan(result.baseSpeed * 0.75);
  expect(result.lateSpeed).toBeLessThan(result.baseSpeed * 1.25);
  expect(result.maxJump).toBeLessThan(4);
  expect(result.maxUncovered).toBeLessThan(1);
  const timing = await host.locator('[part~="track"]').evaluate((track) => ({
    state: track.getAnimations()[0]?.playState,
    rate: track.getAnimations()[0]?.playbackRate,
  }));
  expect(timing).toEqual({ state: 'running', rate: 1 });
});

test('active scroll motion survives focus, refresh, mode changes and reduced motion', async ({
  page,
}) => {
  const host = await mountScroll(page, 'tabindex="0"');
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => movement(host)).toBeLessThan(-100);
  await host.focus();
  await expect.poll(async () => Math.abs(await movement(host))).toBeLessThan(0.1);
  await host.evaluate((element) => element.blur());
  await expect.poll(() => movement(host)).toBeLessThan(-60);

  await page.evaluate(() => window.scrollTo(0, 1000));
  await expect.poll(() => movement(host)).toBeLessThan(-200);
  const speedBeforeRefresh = -(await movement(host));
  const refreshed = await host.evaluate(async (element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    const distance = Number.parseFloat(
      element.style.getPropertyValue('--marquee-content-distance'),
    );
    const before = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    (element as MarqueeContent).refresh();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const delta = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41 - before;
    return Math.abs(delta - Math.round(delta / distance) * distance);
  });
  expect(refreshed).toBeLessThan(60);
  const speedAfterRefresh = -(await movement(host));
  expect(speedAfterRefresh).toBeGreaterThan(speedBeforeRefresh * 0.65);

  for (const mode of ['auto', 'scroll'] as const) {
    const phaseChange = await host.evaluate((element, nextMode) => {
      const track = element.shadowRoot?.querySelector('[part~="track"]');
      if (!track) throw new Error('Moving track is missing');
      const distance = Number.parseFloat(
        element.style.getPropertyValue('--marquee-content-distance'),
      );
      const before = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      (element as MarqueeContent).mode = nextMode;
      const delta = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41 - before;
      return Math.abs(delta - Math.round(delta / distance) * distance);
    }, mode);
    expect(phaseChange).toBeLessThan(1);
    await expect.poll(() => movement(host)).toBeLessThan(-60);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(host).toHaveAttribute('data-marquee-content-reduced-motion');
  await expect(host.locator('[part~="track"]')).toHaveCSS('transform', 'none');
  await expect.poll(async () => Math.abs(await movement(host))).toBeLessThan(0.1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => movement(host)).toBeLessThan(-60);
});
