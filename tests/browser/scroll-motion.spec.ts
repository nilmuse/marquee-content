import { expect, type Locator, type Page, test } from '@playwright/test';
import type { MarqueeContent } from '../../src/marquee-content';

declare global {
  interface Window {
    scrollAnimationCalls: { play: number; rate: number };
    setTouchInput: (matches: boolean) => void;
    setScrollY: (value: number) => void;
    dispatchTouchInput: (
      type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
      clientY: number,
      selector?: string,
      clientX?: number,
    ) => void;
  }
}

async function emulateTouchInput(page: Page, initialMatches: boolean): Promise<void> {
  await page.addInitScript((initial) => {
    const query = '(hover: none) and (pointer: coarse)';
    const matchMedia = window.matchMedia.bind(window);
    const media = matchMedia(query);
    let matches = initial;
    Object.defineProperty(media, 'matches', { get: () => matches });
    window.matchMedia = (value) => (value === query ? media : matchMedia(value));
    window.setTouchInput = (value) => {
      matches = value;
      media.dispatchEvent(new MediaQueryListEvent('change', { matches, media: query }));
    };
    window.dispatchTouchInput = (type, clientY, selector, clientX = 100) => {
      const target = selector ? document.querySelector(selector) : document;
      if (!target) throw new Error('Touch target is missing');
      const touch = { identifier: 1, clientX, clientY, target };
      const touches = type === 'touchend' || type === 'touchcancel' ? [] : [touch];
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touches },
        targetTouches: { value: touches },
        changedTouches: { value: [touch] },
      });
      target.dispatchEvent(event);
    };
  }, initialMatches);
}

async function scrollRuntime(host: Locator) {
  return host.evaluate((element) => {
    const runtime = element as unknown as {
      animationFrameId: number | null;
      isListeningToScroll: boolean;
      scrollBoostStartValue: number;
    };
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    return {
      listening: runtime.isListeningToScroll,
      activeFrame: runtime.animationFrameId !== null,
      boost: runtime.scrollBoostStartValue,
      cssAnimation: getComputedStyle(track).animationName,
      nativeRunning: track.getAnimations().some((animation) => animation.playState === 'running'),
      mode: (element as MarqueeContent).mode,
    };
  });
}

async function emulateScrollY(page: Page, initialValue = 0): Promise<void> {
  await page.addInitScript((initial) => {
    let value = initial;
    for (const property of ['scrollY', 'pageYOffset']) {
      Object.defineProperty(window, property, { configurable: true, get: () => value });
    }
    window.setScrollY = (nextValue) => {
      value = nextValue;
      window.dispatchEvent(new Event('scroll'));
    };
  }, initialValue);
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

test('touch scroll mode follows direction at constant speed without a boost loop', async ({
  page,
}) => {
  await emulateTouchInput(page, true);
  const host = await mountScroll(page, 'speed="80"');
  for (const direction of ['rtl', 'ltr'] as const) {
    await host.evaluate((element, value) => element.setAttribute('direction', value), direction);
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise(requestAnimationFrame);
    });
    const baseSpeed = direction === 'rtl' ? -80 : 80;
    for (const [scrollY, scrollDirection] of [
      [500, 1],
      [0, -1],
      [700, 1],
    ] as const) {
      await page.evaluate(async (value) => {
        window.scrollTo(0, value);
        await new Promise(requestAnimationFrame);
      }, scrollY);
      expect(Math.abs((await movement(host)) - baseSpeed * scrollDirection)).toBeLessThan(20);
      expect(await scrollRuntime(host)).toEqual({
        listening: true,
        activeFrame: false,
        boost: 0,
        cssAnimation: 'marquee-content-auto',
        nativeRunning: true,
        mode: 'scroll',
      });
      await expect(host).toHaveAttribute('mode', 'scroll');
      await expect(host).toHaveAttribute('data-marquee-content-mode', 'scroll');
    }
  }
});

for (const edge of ['top', 'bottom'] as const) {
  test(`touch overscroll at the ${edge} edge preserves direction and native motion`, async ({
    page,
  }) => {
    await emulateTouchInput(page, true);
    await emulateScrollY(page);
    const host = await mountScroll(page, 'speed="80"');
    const maxScroll = await page.evaluate(() => {
      const scroller = document.scrollingElement ?? document.documentElement;
      return scroller.scrollHeight - scroller.clientHeight;
    });
    expect(maxScroll).toBeGreaterThan(100);
    const edgeY = edge === 'top' ? 0 : maxScroll;
    const towardEdge = edge === 'top' ? -1 : 1;

    for (const direction of ['rtl', 'ltr'] as const) {
      await host.evaluate((element, value) => element.setAttribute('direction', value), direction);
      await page.evaluate(
        ({ edgeY, towardEdge }) => {
          window.setScrollY(edgeY - towardEdge * 100);
          window.setScrollY(edgeY);
        },
        { edgeY, towardEdge },
      );
      const result = await host.evaluate(
        (element, { edgeY, towardEdge }) => {
          const track = element.shadowRoot?.querySelector('[part~="track"]');
          if (!track) throw new Error('Moving track is missing');
          const animation = track.getAnimations()[0];
          const directions = [];
          let sameAnimation = true;
          for (const offset of [36, 60, 36, 12, 0, -0.8, 0]) {
            window.setScrollY(edgeY + towardEdge * offset);
            directions.push(getComputedStyle(track).animationDirection);
            sameAnimation &&= track.getAnimations()[0] === animation;
          }
          return { directions, sameAnimation };
        },
        { edgeY, towardEdge },
      );
      const speed = (direction === 'rtl' ? -80 : 80) * towardEdge;
      expect(result.directions).toEqual(Array(7).fill(speed < 0 ? 'normal' : 'reverse'));
      expect(result.sameAnimation).toBe(true);
      expect(Math.abs((await movement(host)) - speed)).toBeLessThan(20);
      expect(await scrollRuntime(host)).toMatchObject({
        activeFrame: false,
        boost: 0,
        nativeRunning: true,
      });

      await page.evaluate((value) => window.setScrollY(value), edgeY - towardEdge * 20);
      expect(Math.abs((await movement(host)) + speed)).toBeLessThan(20);
    }
  });

  test(`touch momentum at the ${edge} edge ignores recoil back inside the page`, async ({
    page,
  }) => {
    await emulateTouchInput(page, true);
    await emulateScrollY(page);
    const host = await mountScroll(page, 'speed="80"');
    for (const direction of ['rtl', 'ltr'] as const) {
      await host.evaluate((element, value) => element.setAttribute('direction', value), direction);
      const result = await host.evaluate((element, edge) => {
        const track = element.shadowRoot?.querySelector('[part~="track"]');
        if (!track) throw new Error('Moving track is missing');
        const scroller = document.scrollingElement ?? document.documentElement;
        const edgeY = edge === 'top' ? 0 : scroller.scrollHeight - scroller.clientHeight;
        const towardEdge = edge === 'top' ? -1 : 1;
        window.dispatchEvent(new Event('scrollend'));
        window.setScrollY(edgeY - towardEdge * 100);
        window.dispatchTouchInput('touchstart', 200);
        window.dispatchTouchInput('touchmove', 200 - towardEdge * 40);
        window.setScrollY(edgeY);
        window.dispatchTouchInput('touchend', 200 - towardEdge * 40);
        const animation = track.getAnimations()[0];
        const directions = [];
        let sameAnimation = true;
        for (const offset of [36, 60, 36, 12, 0, -8, -22, -12, 0]) {
          window.setScrollY(edgeY + towardEdge * offset);
          directions.push(getComputedStyle(track).animationDirection);
          sameAnimation &&= track.getAnimations()[0] === animation;
        }
        return { directions, sameAnimation };
      }, edge);
      const speed = (direction === 'rtl' ? -80 : 80) * (edge === 'top' ? -1 : 1);
      expect(result.directions).toEqual(Array(9).fill(speed < 0 ? 'normal' : 'reverse'));
      expect(result.sameAnimation).toBe(true);
      expect(Math.abs((await movement(host)) - speed)).toBeLessThan(20);
      expect(await scrollRuntime(host)).toMatchObject({
        activeFrame: false,
        boost: 0,
        nativeRunning: true,
      });
    }
  });

  test(`touch reaching the ${edge} boundary without overscroll can reverse before touchmove`, async ({
    page,
  }) => {
    await emulateTouchInput(page, true);
    await emulateScrollY(page);
    const host = await mountScroll(page, 'speed="80"');
    const directions = await host.evaluate((element, edge) => {
      const track = element.shadowRoot?.querySelector('[part~="track"]');
      if (!track) throw new Error('Moving track is missing');
      const scroller = document.scrollingElement ?? document.documentElement;
      const edgeY = edge === 'top' ? 0 : scroller.scrollHeight - scroller.clientHeight;
      const towardEdge = edge === 'top' ? -1 : 1;
      window.setScrollY(edgeY - towardEdge * 100);
      window.dispatchTouchInput('touchstart', 200);
      window.dispatchTouchInput('touchmove', 200 - towardEdge * 40);
      window.setScrollY(edgeY);
      const atEdge = getComputedStyle(track).animationDirection;
      window.dispatchTouchInput('touchend', 200 - towardEdge * 40);
      window.dispatchTouchInput('touchstart', 200);
      window.setScrollY(edgeY - towardEdge * 20);
      return [atEdge, getComputedStyle(track).animationDirection];
    }, edge);
    expect(directions).toEqual(edge === 'top' ? ['reverse', 'normal'] : ['normal', 'reverse']);
  });

  test(`touch reversal after ${edge} recoil replays the page delta when touchmove arrives later`, async ({
    page,
  }) => {
    await emulateTouchInput(page, true);
    await emulateScrollY(page);
    const host = await mountScroll(page, 'speed="80"');
    const directions = await host.evaluate((element, edge) => {
      const track = element.shadowRoot?.querySelector('[part~="track"]');
      if (!track) throw new Error('Moving track is missing');
      const scroller = document.scrollingElement ?? document.documentElement;
      const edgeY = edge === 'top' ? 0 : scroller.scrollHeight - scroller.clientHeight;
      const towardEdge = edge === 'top' ? -1 : 1;
      window.setScrollY(edgeY - towardEdge * 100);
      window.dispatchTouchInput('touchstart', 200);
      window.dispatchTouchInput('touchmove', 200 - towardEdge * 40);
      window.setScrollY(edgeY);
      window.dispatchTouchInput('touchend', 200 - towardEdge * 40);
      window.setScrollY(edgeY + towardEdge * 36);
      window.setScrollY(edgeY - towardEdge * 8);
      const afterRecoil = getComputedStyle(track).animationDirection;
      window.dispatchTouchInput('touchstart', 200);
      window.setScrollY(edgeY - towardEdge * 24);
      const beforeTouchMove = getComputedStyle(track).animationDirection;
      window.dispatchTouchInput('touchmove', 200 + towardEdge * 40);
      return [afterRecoil, beforeTouchMove, getComputedStyle(track).animationDirection];
    }, edge);
    expect(directions).toEqual(
      edge === 'top' ? ['reverse', 'reverse', 'normal'] : ['normal', 'normal', 'reverse'],
    );
  });

  test(`a fresh inward touch gesture immediately after ${edge} recoil reverses normally`, async ({
    page,
  }) => {
    await emulateTouchInput(page, true);
    await emulateScrollY(page);
    const host = await mountScroll(page, 'speed="80"');
    const directions = await host.evaluate((element, edge) => {
      const track = element.shadowRoot?.querySelector('[part~="track"]');
      if (!track) throw new Error('Moving track is missing');
      const scroller = document.scrollingElement ?? document.documentElement;
      const edgeY = edge === 'top' ? 0 : scroller.scrollHeight - scroller.clientHeight;
      const towardEdge = edge === 'top' ? -1 : 1;
      window.setScrollY(edgeY - towardEdge * 100);
      window.dispatchTouchInput('touchstart', 200);
      window.dispatchTouchInput('touchmove', 200 - towardEdge * 40);
      window.setScrollY(edgeY);
      window.dispatchTouchInput('touchend', 200 - towardEdge * 40);
      window.setScrollY(edgeY + towardEdge * 36);
      window.setScrollY(edgeY);
      const afterRecoil = getComputedStyle(track).animationDirection;
      window.dispatchTouchInput('touchstart', 200);
      window.dispatchTouchInput('touchmove', 200 + towardEdge * 40);
      const beforePageScroll = getComputedStyle(track).animationDirection;
      window.setScrollY(edgeY - towardEdge * 20);
      return [afterRecoil, beforePageScroll, getComputedStyle(track).animationDirection];
    }, edge);
    expect(directions).toEqual(
      edge === 'top' ? ['reverse', 'reverse', 'normal'] : ['normal', 'normal', 'reverse'],
    );
  });

  test(`an active touch gesture can reverse inward after ${edge} overscroll`, async ({ page }) => {
    await emulateTouchInput(page, true);
    await emulateScrollY(page);
    const host = await mountScroll(page, 'speed="80"');
    const directions = await host.evaluate((element, edge) => {
      const track = element.shadowRoot?.querySelector('[part~="track"]');
      if (!track) throw new Error('Moving track is missing');
      const scroller = document.scrollingElement ?? document.documentElement;
      const edgeY = edge === 'top' ? 0 : scroller.scrollHeight - scroller.clientHeight;
      const towardEdge = edge === 'top' ? -1 : 1;
      window.setScrollY(edgeY - towardEdge * 100);
      window.dispatchTouchInput('touchstart', 200);
      window.dispatchTouchInput('touchmove', 200 - towardEdge * 40);
      window.setScrollY(edgeY);
      window.setScrollY(edgeY + towardEdge * 36);
      window.setScrollY(edgeY);
      const afterRecoil = getComputedStyle(track).animationDirection;
      window.dispatchTouchInput('touchmove', 200);
      const beforePageScroll = getComputedStyle(track).animationDirection;
      window.setScrollY(edgeY - towardEdge * 20);
      return [afterRecoil, beforePageScroll, getComputedStyle(track).animationDirection];
    }, edge);
    expect(directions).toEqual(
      edge === 'top' ? ['reverse', 'reverse', 'normal'] : ['normal', 'normal', 'reverse'],
    );
  });
}

test('touch recoil preserves direction when the bottom scroll boundary moves', async ({ page }) => {
  await emulateTouchInput(page, true);
  await emulateScrollY(page);
  const host = await mountScroll(page, 'speed="80"');
  const directions = await host.evaluate((element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    const scroller = document.scrollingElement ?? document.documentElement;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    window.setScrollY(maxScroll - 100);
    window.dispatchTouchInput('touchstart', 200);
    window.dispatchTouchInput('touchmove', 160);
    window.setScrollY(maxScroll);
    window.dispatchTouchInput('touchcancel', 160);
    window.setScrollY(maxScroll + 60);
    document.body.style.minHeight = `${scroller.scrollHeight + 120}px`;
    return [36, 12, 0, -8, -22].map((offset) => {
      window.setScrollY(maxScroll + offset);
      return getComputedStyle(track).animationDirection;
    });
  });
  expect(directions).toEqual(Array(5).fill('normal'));
  expect(Math.abs((await movement(host)) + 80)).toBeLessThan(20);
});

test('interior page scrolling reverses immediately before the first touchmove', async ({
  page,
}) => {
  await emulateTouchInput(page, true);
  await emulateScrollY(page);
  const host = await mountScroll(page, 'speed="80"');
  const directions = await host.evaluate((element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    window.setScrollY(500);
    window.dispatchTouchInput('touchstart', 200);
    window.setScrollY(480);
    const reversed = getComputedStyle(track).animationDirection;
    window.setScrollY(520);
    return [reversed, getComputedStyle(track).animationDirection];
  });
  expect(directions).toEqual(['reverse', 'normal']);
});

test('interior page scrolling after touchend ignores the previous finger direction', async ({
  page,
}) => {
  await emulateTouchInput(page, true);
  await emulateScrollY(page);
  const host = await mountScroll(page, 'speed="80"');
  const directions = await host.evaluate((element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    window.setScrollY(500);
    window.dispatchTouchInput('touchstart', 200);
    window.dispatchTouchInput('touchmove', 160);
    window.setScrollY(600);
    window.dispatchTouchInput('touchend', 160);
    return [580, 620, 600].map((value) => {
      window.setScrollY(value);
      return getComputedStyle(track).animationDirection;
    });
  });
  expect(directions).toEqual(['reverse', 'normal', 'reverse']);
});

test('interior page direction stays responsive when diagonal touch events lag or the gesture ends', async ({
  page,
}) => {
  await emulateTouchInput(page, true);
  await emulateScrollY(page);
  const host = await mountScroll(page, 'speed="80"');
  const result = await host.evaluate((element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    const animation = track.getAnimations()[0];
    const directions: string[] = [];
    const scroll = (value: number): void => {
      window.setScrollY(value);
      directions.push(getComputedStyle(track).animationDirection);
    };
    window.setScrollY(500);
    window.dispatchTouchInput('touchstart', 200);
    window.dispatchTouchInput('touchmove', 180, undefined, 160);
    scroll(540);
    window.dispatchTouchInput('touchmove', 220, undefined, 240);
    scroll(560);
    scroll(530);
    window.dispatchTouchInput('touchend', 220);
    scroll(550);
    window.dispatchTouchInput('touchstart', 240);
    window.dispatchTouchInput('touchmove', 200, undefined, 180);
    scroll(560);
    window.dispatchTouchInput('touchcancel', 200);
    scroll(550);
    window.dispatchEvent(new Event('scrollend'));
    scroll(530);
    return { directions, sameAnimation: track.getAnimations()[0] === animation };
  });
  expect(result.directions).toEqual([
    'normal',
    'normal',
    'reverse',
    'normal',
    'normal',
    'reverse',
    'reverse',
  ]);
  expect(result.sameAnimation).toBe(true);
  expect(Math.abs((await movement(host)) - 80)).toBeLessThan(20);
});

test('touch idle fallback waits for page scrolling to stop and keeps active gestures', async ({
  page,
}) => {
  await emulateTouchInput(page, true);
  await emulateScrollY(page);
  const host = await mountScroll(page, 'speed="80"');
  const directions = await host.evaluate(async (element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    const directions: string[] = [];
    const wait = (delay: number): Promise<void> =>
      new Promise((resolve) => window.setTimeout(resolve, delay));
    const scroll = (value: number): void => {
      window.setScrollY(value);
      directions.push(getComputedStyle(track).animationDirection);
    };
    const scroller = document.scrollingElement ?? document.documentElement;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    window.setScrollY(maxScroll - 100);
    window.dispatchTouchInput('touchstart', 200);
    window.dispatchTouchInput('touchmove', 160);
    window.setScrollY(maxScroll);
    window.setScrollY(maxScroll + 36);
    await wait(300);
    scroll(maxScroll - 20);
    window.dispatchTouchInput('touchend', 160);
    for (const offset of [40, 60, 80]) {
      await wait(150);
      scroll(maxScroll - offset);
    }
    await wait(300);
    scroll(maxScroll - 100);
    window.dispatchTouchInput('touchstart', 200);
    window.dispatchTouchInput('touchmove', 160);
    scroll(maxScroll);
    window.setScrollY(maxScroll + 36);
    window.dispatchTouchInput('touchend', 160);
    await wait(150);
    window.dispatchTouchInput('touchstart', 200);
    await wait(300);
    scroll(maxScroll - 20);
    window.dispatchTouchInput('touchmove', 160);
    scroll(maxScroll - 40);
    window.dispatchTouchInput('touchcancel', 160);
    for (const offset of [60, 80]) {
      await wait(150);
      scroll(maxScroll - offset);
    }
    await wait(300);
    scroll(maxScroll - 100);
    return directions;
  });
  expect(directions).toEqual([
    'normal',
    'normal',
    'normal',
    'normal',
    'reverse',
    'normal',
    'normal',
    'normal',
    'normal',
    'normal',
    'reverse',
  ]);
});

test('touch movement and nested scrolling cannot reverse a stationary page', async ({ page }) => {
  await emulateTouchInput(page, true);
  await emulateScrollY(page);
  const host = await mountScroll(page, 'speed="80"');
  const directions = await host.evaluate((element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    const nested = document.createElement('div');
    nested.id = 'nested-scroll';
    nested.style.cssText = 'height: 40px; overflow: auto';
    nested.innerHTML = '<div style="height: 200px">Nested scroll content</div>';
    for (const type of ['touchstart', 'touchmove']) {
      nested.addEventListener(type, (event) => event.stopPropagation());
    }
    document.body.append(nested);
    window.setScrollY(500);
    window.dispatchTouchInput('touchstart', 100, '#nested-scroll');
    window.dispatchTouchInput('touchmove', 140, '#nested-scroll');
    const directions = [getComputedStyle(track).animationDirection];
    nested.scrollTop = 40;
    nested.dispatchEvent(new Event('scroll'));
    directions.push(getComputedStyle(track).animationDirection);
    window.setScrollY(500);
    directions.push(getComputedStyle(track).animationDirection);
    window.setScrollY(520);
    directions.push(getComputedStyle(track).animationDirection);
    window.setScrollY(480);
    directions.push(getComputedStyle(track).animationDirection);
    return directions;
  });
  expect(directions).toEqual(['normal', 'normal', 'normal', 'normal', 'reverse']);
});

test('mode and input changes clear touch edge recoil suppression', async ({ page }) => {
  await emulateTouchInput(page, true);
  await emulateScrollY(page);
  const host = await mountScroll(page, 'speed="80"');
  for (const reset of ['mode', 'input', 'disconnect'] as const) {
    const direction = await host.evaluate((element, reset) => {
      const track = element.shadowRoot?.querySelector('[part~="track"]');
      if (!track) throw new Error('Moving track is missing');
      window.dispatchEvent(new Event('scrollend'));
      const scroller = document.scrollingElement ?? document.documentElement;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      window.setScrollY(maxScroll - 100);
      window.dispatchTouchInput('touchstart', 200);
      window.dispatchTouchInput('touchmove', 160);
      window.setScrollY(maxScroll);
      window.setScrollY(maxScroll + 36);
      window.dispatchTouchInput('touchend', 160);
      if (reset === 'mode') {
        (element as MarqueeContent).mode = 'auto';
        (element as MarqueeContent).mode = 'scroll';
      } else if (reset === 'input') {
        window.setTouchInput(false);
        window.setTouchInput(true);
      } else {
        const parent = element.parentElement;
        element.remove();
        parent?.append(element);
      }
      window.setScrollY(maxScroll - 50);
      return getComputedStyle(track).animationDirection;
    }, reset);
    expect(direction, reset).toBe('reverse');
  }
});

test('touch overscroll present on connection does not seed a false reversal', async ({ page }) => {
  await emulateTouchInput(page, true);
  await emulateScrollY(page, 1_000_000);
  const host = await mountScroll(page, 'speed="80"');
  const directions = await host.evaluate((element) => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    return [maxScroll + 36, maxScroll + 12, maxScroll].map((value) => {
      window.setScrollY(value);
      return getComputedStyle(track).animationDirection;
    });
  });
  expect(directions).toEqual(['normal', 'normal', 'normal']);
  expect(Math.abs((await movement(host)) + 80)).toBeLessThan(20);
});

test('changing input capability clears boost and restores desktop scroll behavior', async ({
  page,
}) => {
  await emulateTouchInput(page, false);
  const host = await mountScroll(page, 'speed="80"');
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => movement(host)).toBeLessThan(-120);
  expect(await scrollRuntime(host)).toMatchObject({ listening: true, activeFrame: true });

  await page.evaluate(() => window.setTouchInput(true));
  await expect
    .poll(() => scrollRuntime(host))
    .toEqual({
      listening: true,
      activeFrame: false,
      boost: 0,
      cssAnimation: 'marquee-content-auto',
      nativeRunning: true,
      mode: 'scroll',
    });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(Math.abs((await movement(host)) - 80)).toBeLessThan(20);

  await page.evaluate(() => window.setTouchInput(false));
  await expect
    .poll(() => scrollRuntime(host))
    .toMatchObject({
      listening: true,
      activeFrame: false,
      boost: 0,
      nativeRunning: true,
      mode: 'scroll',
    });
  expect(Math.abs((await movement(host)) - 80)).toBeLessThan(20);
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => movement(host)).toBeLessThan(-120);
  expect(await scrollRuntime(host)).toMatchObject({ listening: true, activeFrame: true });
  await expect(host).toHaveAttribute('mode', 'scroll');
});

test('touch reversals preserve phase and retain native motion after scrolling stops', async ({
  page,
}) => {
  await emulateTouchInput(page, true);
  const host = await mountScroll(page, 'speed="80"');
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => movement(host)).toBeLessThan(-60);
  const reversal = await host.evaluate(async (element) => {
    const track = element.shadowRoot?.querySelector('[part~="track"]');
    if (!track) throw new Error('Moving track is missing');
    const animation = track.getAnimations()[0];
    const distance = Number.parseFloat(
      element.style.getPropertyValue('--marquee-content-distance'),
    );
    const before = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    const started = performance.now();
    const scrolled = new Promise<void>((resolve) =>
      window.addEventListener('scroll', () => resolve(), { once: true }),
    );
    window.scrollTo(0, 0);
    await scrolled;
    const delta = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41 - before;
    return {
      sameAnimation: animation === track.getAnimations()[0],
      distance: Math.abs(delta - Math.round(delta / distance) * distance),
      maximumTravel: (80 * (performance.now() - started)) / 1000 + 2,
    };
  });
  expect(reversal.sameAnimation).toBe(true);
  expect(reversal.distance).toBeLessThan(reversal.maximumTravel);
  expect(Math.abs((await movement(host)) - 80)).toBeLessThan(20);
  await page.waitForTimeout(2700);
  expect(Math.abs((await movement(host)) - 80)).toBeLessThan(20);
  expect(await scrollRuntime(host)).toMatchObject({
    activeFrame: false,
    boost: 0,
    nativeRunning: true,
  });
});
