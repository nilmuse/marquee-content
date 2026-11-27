// Paste this whole script after the component's script on the page being tested.
(() => {
  if (window.marqueeScrollDiagnostics) return;

  const capacity = 2400;
  const host = document.createElement('div');
  host.setAttribute('data-marquee-scroll-diagnostics', '');
  host.style.cssText =
    'position:fixed;inset:auto 8px max(8px,env(safe-area-inset-bottom)) auto;z-index:2147483647;width:min(350px,calc(100vw - 16px))';
  const panel = host.attachShadow({ mode: 'open' });
  panel.innerHTML = `
    <style>
      :host { color-scheme: light; }
      section { padding: 12px; border: 1px solid #b8bdc8; border-radius: 12px;
        background: #fff; color: #17202e; font: 14px/1.4 system-ui, sans-serif;
        box-shadow: 0 3px 20px #0002; }
      p { margin: 6px 0; } .buttons { display: flex; flex-wrap: wrap; gap: 6px; }
      button { min-height: 40px; padding: 6px 12px; border: 1px solid #bcc5d3;
        border-radius: 7px; background: #eef2f8; color: #17202e; font: inherit; }
      button:disabled { opacity: .45; } button:focus-visible { outline: 3px solid #3866e9; }
      details { margin-top: 8px; } textarea { box-sizing: border-box; width: 100%; height: 100px; }
      [hidden] { display: none !important; }
    </style>
    <section aria-label="Диагностика прокрутки marquee-content">
      <strong>Marquee · диагностика v3</strong>
      <p id="status" role="status">Запись выключена.</p>
      <div class="buttons">
        <button id="start" type="button">Начать</button>
        <button id="failure" type="button" disabled>Сбой</button>
        <button id="download" type="button" disabled>Скачать JSON</button>
        <button id="copy" type="button" disabled>Скопировать</button>
      </div>
      <details><summary>Как записать</summary>
        <p>Нажмите «Начать», воспроизведите отскок и сразу после ложного разворота нажмите «Сбой».
        Запись остановится. Скачайте или скопируйте JSON.</p>
        <p>Хранятся последние события. Новая запись заменяет предыдущую.
        Данные остаются в памяти этой страницы до экспорта или перезагрузки.</p>
      </details>
      <label id="fallback" hidden>Скопируйте JSON вручную:
        <textarea id="json" readonly spellcheck="false"></textarea>
      </label>
    </section>`;
  document.documentElement.append(host);
  const $ = (id) => panel.getElementById(id);
  let running = false;
  let started = 0;
  let metadata = null;
  let finishedAt = null;
  let frame = null;
  let lastSignature = '';
  let lastStatusTime = 0;
  let elements = [];
  let records = [];
  let next = 0;
  let sequence = 0;
  let dropped = 0;
  const removers = [];

  function runtime() {
    return elements.map((element, index) => {
      const track = element.shadowRoot?.querySelector('[part~="track"]');
      const value = (key) => element[key] ?? null;
      return {
        instance: `${element.localName}:${index + 1}`,
        connected: element.isConnected,
        mode: element.getAttribute('mode'),
        direction: element.getAttribute('direction'),
        touchInput: value('touchInput'),
        scrollDirectionFactor: value('scrollDirectionFactor'),
        touchScrollDirection: value('touchScrollDirection'),
        touchOverscrollDirection: value('touchOverscrollDirection'),
        touchViewportDirection: value('touchViewportDirection'),
        touchStartedAtScrollEdge: value('touchStartedAtScrollEdge'),
        touchStartedAtBottomEdge: value('touchStartedAtBottomEdge'),
        pendingTouchScrollDirection: value('pendingTouchScrollDirection'),
        lastTouchY: value('lastTouchY'),
        lastScrollY: value('lastScrollY'),
        lastScrollTime: value('lastScrollTime'),
        lastScrollViewportHeight: value('lastScrollViewportHeight'),
        resetTimerPending: element.touchScrollResetTimer != null,
        cssDirection: track?.style.animationDirection ?? null,
        cssPlayState: track?.style.animationPlayState ?? null,
      };
    });
  }

  function viewport() {
    const root = document.scrollingElement ?? document.documentElement;
    const raw = window.scrollY || window.pageYOffset || 0;
    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    const normalized = raw <= 1 ? 0 : raw >= max - 1 ? max : raw;
    const visual = window.visualViewport;
    const size = (element) =>
      element ? { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight } : null;
    return {
      scrollY: window.scrollY,
      pageYOffset: window.pageYOffset,
      scrollTop: root.scrollTop,
      maxScrollY: max,
      normalizedY: normalized,
      overscroll: raw - normalized,
      scrollingElement: root.localName,
      root: size(root),
      html: size(document.documentElement),
      body: size(document.body),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visual: visual
        ? {
            pageTop: visual.pageTop,
            offsetTop: visual.offsetTop,
            width: visual.width,
            height: visual.height,
            scale: visual.scale,
          }
        : null,
      visibility: document.visibilityState,
    };
  }

  function eventData(event) {
    if (!event) return null;
    const points = (touches) =>
      touches
        ? Array.from(touches, (touch) => ({
            id: touch.identifier,
            clientX: touch.clientX,
            clientY: touch.clientY,
            pageY: touch.pageY,
            screenY: touch.screenY,
          }))
        : null;
    const target = event.target;
    return {
      trusted: event.isTrusted,
      timeStamp: event.timeStamp,
      target:
        target === window
          ? 'window'
          : target === document
            ? 'document'
            : (target?.localName ?? 'visualViewport'),
      diagnosticsControl: event.composedPath().includes(host),
      touches: points(event.touches),
      changedTouches: points(event.changedTouches),
    };
  }

  function record(type, phase = null, event = null, states = runtime()) {
    if (!running) return;
    const entry = {
      seq: ++sequence,
      t: Math.round((performance.now() - started) * 1000) / 1000,
      type,
      phase,
      event: eventData(event),
      viewport: viewport(),
      runtime: states,
    };
    if (records.length < capacity) records.push(entry);
    else {
      records[next] = entry;
      next = (next + 1) % capacity;
      dropped += 1;
    }
  }

  function updateStatus(message) {
    $('status').textContent =
      message ??
      `${running ? 'Запись' : 'Остановлено'} · ${records.length} событий · строк: ${elements.length}${dropped ? ` · вытеснено: ${dropped}` : ''}`;
    $('failure').disabled = !running;
    $('download').disabled = records.length === 0;
    $('copy').disabled = records.length === 0;
    $('start').textContent = records.length ? 'Заново' : 'Начать';
  }

  function listen(target, type, phase = 'capture') {
    const capture = phase === 'capture';
    const listener = (event) => record(type, phase, event);
    target.addEventListener(type, listener, { capture, passive: true });
    removers.push(() => target.removeEventListener(type, listener, capture));
  }

  function tick(now) {
    if (!running) return;
    // Plain field reads only; capture layout/viewport metrics when state changes.
    // This also observes idle-timer resets which have no corresponding DOM event.
    const states = runtime();
    const signature = JSON.stringify(states);
    if (signature !== lastSignature) {
      record('runtime-change', 'frame', null, states);
      lastSignature = signature;
    }
    if (now - lastStatusTime >= 250) {
      updateStatus();
      lastStatusTime = now;
    }
    frame = requestAnimationFrame(tick);
  }

  function getReport() {
    const ordered = [...records.slice(next), ...records.slice(0, next)];
    return JSON.parse(
      JSON.stringify({
        schema: 'marquee-content-scroll-diagnostics/v1',
        metadata,
        finishedAt,
        recording: running,
        capacity,
        dropped,
        records: ordered,
      }),
    );
  }

  function stop(reason = 'stop') {
    if (running) {
      record(reason);
      running = false;
      finishedAt = new Date().toISOString();
      for (const remove of removers.splice(0)) remove();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    }
    updateStatus();
  }

  function start() {
    stop();
    elements = Array.from(
      document.querySelectorAll('marquee-content, [data-marquee-content-ready]'),
    ).slice(0, 20);
    records = [];
    next = 0;
    sequence = 0;
    dropped = 0;
    finishedAt = null;
    started = performance.now();
    lastStatusTime = started;
    const style = getComputedStyle(document.documentElement);
    metadata = {
      recorderVersion: 3,
      startedAt: new Date().toISOString(),
      performanceStartedAt: started,
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      screen: { width: screen.width, height: screen.height },
      touchInput: matchMedia('(hover: none) and (pointer: coarse)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      scrollendSupported: 'onscrollend' in window,
      inFrame: window !== window.top,
      rootStyles: {
        overscrollBehaviorY: style.overscrollBehaviorY,
        touchAction: style.touchAction,
      },
      componentSources: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => /marquee-content[^/]*\/.*index\.js|\/dist\/index\.js/.test(name))
        .map((name) => {
          const url = new URL(name);
          return `${url.origin}${url.pathname}`;
        })
        .slice(-10),
    };
    $('fallback').hidden = true;
    $('json').value = '';
    running = true;
    record('start');
    for (const type of [
      'scroll',
      'scrollend',
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
    ]) {
      listen(window, type, 'capture');
      listen(window, type, 'bubble');
    }
    for (const type of ['resize', 'orientationchange']) listen(window, type);
    listen(document, 'visibilitychange');
    if (window.visualViewport) {
      listen(window.visualViewport, 'scroll', 'visualViewport');
      listen(window.visualViewport, 'resize', 'visualViewport');
    }
    lastSignature = JSON.stringify(runtime());
    frame = requestAnimationFrame(tick);
    updateStatus();
  }

  function failure() {
    if (running) {
      record('failure-mark');
      stop('frozen-after-failure');
      updateStatus('Сбой отмечен. Запись остановлена — скачайте или скопируйте JSON.');
    }
  }

  function json() {
    return JSON.stringify(getReport(), null, 2);
  }

  function download() {
    stop('export');
    const url = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `marquee-scroll-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function copy() {
    stop('export');
    const text = json();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      updateStatus('JSON скопирован.');
    } catch {
      $('json').value = text;
      $('fallback').hidden = false;
      $('json').focus();
      $('json').select();
      updateStatus('Выделите и скопируйте JSON вручную.');
    }
  }

  $('start').addEventListener('click', start);
  $('failure').addEventListener('click', failure);
  $('download').addEventListener('click', download);
  $('copy').addEventListener('click', copy);
  window.marqueeScrollDiagnostics = {
    version: 3,
    start,
    stop,
    failure,
    getReport,
    download,
    copy,
    destroy() {
      stop();
      host.remove();
      delete window.marqueeScrollDiagnostics;
    },
  };
})();
