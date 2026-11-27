import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';

interface DiagnosticReport {
  schema: string;
  recording: boolean;
  capacity: number;
  dropped: number;
  metadata: { componentSources: string[]; touchInput: boolean };
  records: {
    seq: number;
    t: number;
    type: string;
    phase: string | null;
    viewport: { scrollY: number; overscroll: number; maxScrollY: number };
    runtime: { touchOverscrollDirection: number; scrollDirectionFactor: number }[];
  }[];
}

declare global {
  interface Window {
    marqueeScrollDiagnostics: {
      start(): void;
      stop(): void;
      failure(): void;
      getReport(): DiagnosticReport;
      destroy(): void;
    };
  }
}

async function mountDiagnostics(page: Page): Promise<void> {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const media = matchMedia(query);
      if (query === '(hover: none) and (pointer: coarse)') {
        Object.defineProperty(media, 'matches', { value: true });
      }
      return media;
    };
  });
  await page.goto('/diagnostics/?local');
  await expect(page.locator('[data-marquee-content-ready]')).toHaveCount(2);
  await expect(page.getByText('Компонент: /dist/index.js', { exact: true })).toBeVisible();
}

test('recording preserves scroll decisions and freezes an exportable failure trace', async ({
  page,
}) => {
  await mountDiagnostics(page);
  const result = await page.evaluate(async () => {
    let scrollY = 0;
    for (const property of ['scrollY', 'pageYOffset']) {
      Object.defineProperty(window, property, { configurable: true, get: () => scrollY });
    }
    const scroll = (value: number) => {
      scrollY = value;
      window.dispatchEvent(new Event('scroll'));
    };
    const touch = (type: string, clientY: number) => {
      const point = {
        identifier: 1,
        clientX: 100,
        clientY,
        pageY: clientY + scrollY,
        screenY: clientY,
      };
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' ? [] : [point] },
        changedTouches: { value: [point] },
      });
      document.dispatchEvent(event);
    };
    const elements = Array.from(document.querySelectorAll('marquee-content'));
    const state = () =>
      elements.map((element) => {
        const fields = element as unknown as Record<string, unknown>;
        return [
          fields.scrollDirectionFactor,
          fields.touchOverscrollDirection,
          fields.pendingTouchScrollDirection,
          fields.lastScrollY,
        ];
      });
    const run = () => {
      const samples = [];
      window.dispatchEvent(new Event('scrollend'));
      scroll(100);
      touch('touchstart', 200);
      touch('touchmove', 240);
      scroll(0);
      touch('touchend', 240);
      for (const value of [-36, 0, 8]) {
        scroll(value);
        samples.push(state());
      }
      touch('touchstart', 200);
      scroll(20);
      samples.push(state());
      touch('touchmove', 160);
      samples.push(state());
      touch('touchend', 160);
      return samples;
    };
    const withoutRecording = run();
    window.marqueeScrollDiagnostics.start();
    const withRecording = run();
    await new Promise(requestAnimationFrame);
    window.marqueeScrollDiagnostics.failure();
    const frozen = window.marqueeScrollDiagnostics.getReport();
    scroll(40);
    await new Promise(requestAnimationFrame);
    return {
      withoutRecording,
      withRecording,
      frozen,
      unchanged:
        JSON.stringify(frozen) === JSON.stringify(window.marqueeScrollDiagnostics.getReport()),
    };
  });
  expect(result.withRecording).toEqual(result.withoutRecording);
  expect(result.unchanged).toBe(true);
  expect(result.frozen.recording).toBe(false);
  expect(result.frozen.metadata.touchInput).toBe(true);
  expect(result.frozen.metadata.componentSources).toContain('http://127.0.0.1:4173/dist/index.js');
  expect(result.frozen.records.some((entry) => entry.viewport.overscroll === -36)).toBe(true);
  expect(
    result.frozen.records.some((entry) => entry.runtime[0].touchOverscrollDirection === -1),
  ).toBe(true);
  expect(result.frozen.records.some((entry) => entry.type === 'failure-mark')).toBe(true);
  expect(
    result.frozen.records.filter((entry) => entry.type === 'scroll').map((entry) => entry.phase),
  ).toContain('capture');
  expect(
    result.frozen.records.filter((entry) => entry.type === 'scroll').map((entry) => entry.phase),
  ).toContain('bubble');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  await page.getByRole('button', { name: 'Скопировать', exact: true }).click();
  const fallback = page.locator('[data-marquee-scroll-diagnostics] textarea');
  await expect(fallback).toBeVisible();
  expect(JSON.parse(await fallback.inputValue())).toEqual(result.frozen);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать JSON', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^marquee-scroll-.*\.json$/);
  const path = await download.path();
  if (!path) throw new Error('Diagnostic JSON download is missing');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(result.frozen);
});

test('a frame snapshot captures the silent idle reset of rebound protection', async ({ page }) => {
  await mountDiagnostics(page);
  await page.evaluate(() => {
    let scrollY = 100;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    window.dispatchEvent(new Event('scroll'));
    window.marqueeScrollDiagnostics.start();
    const touch = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'touches', {
        value: type === 'touchend' ? [] : [{ clientY }],
      });
      document.dispatchEvent(event);
    };
    touch('touchstart', 200);
    touch('touchmove', 240);
    scrollY = -36;
    window.dispatchEvent(new Event('scroll'));
    touch('touchend', 240);
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.marqueeScrollDiagnostics
          .getReport()
          .records.filter((entry) => entry.type === 'runtime-change')
          .map((entry) => entry.runtime[0].touchOverscrollDirection),
      ),
    )
    .toEqual([-1, 0]);
  await page.evaluate(() => window.marqueeScrollDiagnostics.stop());
});

test('the recorder bounds its history, restarts cleanly and can be removed', async ({ page }) => {
  await mountDiagnostics(page);
  const result = await page.evaluate(() => {
    const recorder = window.marqueeScrollDiagnostics;
    recorder.start();
    for (let index = 0; index < 1300; index += 1) window.dispatchEvent(new Event('scroll'));
    recorder.stop();
    const bounded = recorder.getReport();
    recorder.start();
    recorder.stop();
    const restarted = recorder.getReport();
    recorder.destroy();
    const frozen = JSON.stringify(recorder.getReport());
    window.dispatchEvent(new Event('scroll'));
    return {
      count: bounded.records.length,
      capacity: bounded.capacity,
      dropped: bounded.dropped,
      ordered: bounded.records.every((entry, index, entries) =>
        index === 0 ? true : entry.seq > entries[index - 1].seq,
      ),
      restarted: { count: restarted.records.length, dropped: restarted.dropped },
      removed: !document.querySelector('[data-marquee-scroll-diagnostics]'),
      stopped: frozen === JSON.stringify(recorder.getReport()),
    };
  });
  expect(result.count).toBe(result.capacity);
  expect(result.dropped).toBeGreaterThan(0);
  expect(result.ordered).toBe(true);
  expect(result.restarted).toEqual({ count: 2, dropped: 0 });
  expect(result.removed).toBe(true);
  expect(result.stopped).toBe(true);
});
