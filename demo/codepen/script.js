(() => {
  const CDN = 'https://cdn.jsdelivr.net/npm/marquee-content@7.0.0-dev.0/dist/index.js';
  const $ = (id) => document.getElementById(id);
  const sample = $('sample');
  const form = $('controls');
  const surface = $('preview-surface');
  const stage = $('preview-stage');
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const defaults = {
    example: 'text',
    speed: 90,
    gap: 40,
    width: 100,
    direction: 'rtl',
    mode: 'auto',
    responsive: false,
    hover: false,
  };
  const state = { ...defaults };
  let language = 'html';
  let loaded = false;
  let loading = false;
  let copiedText = '';

  const textItems = ['presto', 'tempo', 'vomero', 'pegasus'].map((name) => ({
    part: name,
    name: name[0].toUpperCase() + name.slice(1),
  }));
  const marks = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="48" viewBox="0 0 180 48"><path d="M4 32 20 8l16 24-16-8Z" fill="#37482b"/><text x="44" y="34" font-family="Arial,sans-serif" font-weight="900" font-size="29" fill="#37482b">PRESTO</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="170" height="48" viewBox="0 0 170 48"><g fill="none" stroke="#65704e" stroke-width="3"><circle cx="21" cy="24" r="16"/><path d="M21 12v12l9 6"/></g><text x="48" y="34" font-family="Georgia,serif" font-style="italic" font-size="34" fill="#65704e">tempo</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="194" height="48" viewBox="0 0 194 48"><path d="m3 9 17 30L37 9M12 9l8 15 8-15" fill="none" stroke="#24251f" stroke-width="4"/><text x="48" y="33" font-family="Arial,sans-serif" font-weight="700" letter-spacing="2" font-size="25" fill="#24251f">VOMERO</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="188" height="48" viewBox="0 0 188 48"><g fill="none" stroke="#7b805d" stroke-width="3"><path d="m4 14 18 10L4 34M15 14l18 10-18 10"/></g><text x="44" y="33" font-family="Arial,sans-serif" font-size="28" fill="#7b805d">pegasus</text></svg>',
  ];
  const images = textItems.map((item, index) => ({
    ...item,
    src: `data:image/svg+xml,${encodeURIComponent(marks[index]).replaceAll("'", '%27')}`,
    width: [180, 170, 194, 188][index],
  }));

  function contentMarkup() {
    if (state.example === 'text') {
      return textItems.map((item) => `  <span part="${item.part}">${item.name}</span>`).join('\n');
    }
    return images
      .map(
        (item) =>
          `  <img part="${item.part}"\n    src="${item.src}"\n    alt="${item.name}" width="${item.width}" height="48">`,
      )
      .join('\n');
  }

  function snippets() {
    const className = state.example === 'text' ? 'ticker' : 'logos';
    const html = `<marquee-content class="${className}"\n  speed="${state.speed}" direction="${state.direction}" mode="${state.mode}"\n  responsive-speed="${state.responsive}" pause-on-hover="${state.hover}">\n${contentMarkup()}\n</marquee-content>`;
    const base = `.${className} {\n  --marquee-content-gap: ${state.gap}px;`;
    const css =
      state.example === 'text'
        ? `${base}\n  color: #24251f;\n  font: 600 clamp(36px, 6vw, 76px) / 1.2 system-ui, sans-serif;\n  letter-spacing: -0.04em;\n  text-transform: uppercase;\n}\n\n.ticker::part(presto) { color: #37482b; font-weight: 700; }\n.ticker::part(tempo) { color: #65704e; font-weight: 400; }\n.ticker::part(vomero) { color: #24251f; font-weight: 600; }\n.ticker::part(pegasus) { color: #7b805d; font-weight: 500; }`
        : `${base}\n}\n\n.logos::part(item) {\n  width: auto;\n  height: 48px;\n  object-fit: contain;\n}\n\n.logos::part(presto) {\n  height: 40px;\n}`;
    return {
      html,
      css,
      js: `// Registers <marquee-content>; styles are included.\nimport('${CDN}');`,
    };
  }

  function fullExample() {
    const { html, css, js } = snippets();
    // biome-ignore lint/suspicious/noUselessEscapeInString: CodePen may inline this script in HTML.
    return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>marquee-content example</title>\n  <style>\n${css}\n  </style>\n</head>\n<body>\n${html}\n<script type="module">\n${js}\n<\/script>\n</body>\n</html>`;
  }

  function updateCode() {
    copiedText = '';
    $('generated-code').textContent = snippets()[language];
    $('code-output').scrollTo(0, 0);
    $('copy-tab').textContent = `Copy ${language.toUpperCase()}`;
    $('code-output').setAttribute('aria-labelledby', `tab-${language}`);
    document.querySelectorAll('[data-language]').forEach((tab) => {
      const active = tab.dataset.language === language;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $('copy-status').textContent = '';
    $('copy-fallback').hidden = true;
  }

  function updateSummary() {
    const width = sample.getBoundingClientRect().width;
    const factor = state.responsive ? Math.max(0.55, Math.min(1, width / 1280)) : 1;
    const base = (state.speed * factor).toFixed(1).replace(/\.0$/, '');
    $('speed-summary').textContent =
      width > 0
        ? media.matches
          ? `${Math.round(width)} px container · static (reduced motion)`
          : `${Math.round(width)} px container · ${base} px/s${state.mode === 'scroll' ? ' base + scroll' : ''}`
        : 'Preview hidden';
  }

  function updateMotionNote() {
    $('motion-note').textContent = media.matches
      ? 'Reduced motion is on: all items form one static, wrapping row.'
      : state.mode === 'scroll'
        ? 'Page scroll mode · scroll down and back up to try both directions.'
        : state.hover
          ? 'Continuous movement · hover over the row to pause.'
          : 'Continuous movement · respects your device’s reduced-motion setting.';
  }

  function render(replaceContent = false) {
    if (replaceContent) sample.innerHTML = contentMarkup();
    sample.className = `sample sample--${state.example}`;
    for (const [name, value] of Object.entries({
      speed: state.speed,
      direction: state.direction,
      mode: state.mode,
      'responsive-speed': state.responsive,
      'pause-on-hover': state.hover,
    })) {
      sample.setAttribute(name, String(value));
    }
    sample.style.setProperty('--marquee-content-gap', `${state.gap}px`);
    surface.style.width = `${state.width}%`;
    $('speed-value').textContent = `${state.speed} px/s`;
    $('gap-value').textContent = `${state.gap} px`;
    $('width-value').textContent = `${state.width}%`;
    $('scroll-hint').hidden = state.mode !== 'scroll';
    document.querySelectorAll('[data-example]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.example === state.example));
    });
    updateCode();
    updateMotionNote();
    updateSummary();
  }

  for (const id of ['speed', 'gap', 'width', 'direction', 'mode', 'responsive', 'hover']) {
    $(id).addEventListener('input', (event) => {
      const input = event.currentTarget;
      state[id] =
        input.type === 'checkbox'
          ? input.checked
          : input.type === 'range'
            ? Number(input.value)
            : input.value;
      render();
    });
  }
  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('reset', () => {
    Object.assign(state, defaults);
    for (const id of ['speed', 'gap', 'width', 'direction', 'mode', 'responsive', 'hover']) {
      if ($(id).type === 'checkbox') $(id).checked = defaults[id];
      else $(id).value = defaults[id];
    }
    render(true);
  });
  document.querySelectorAll('[data-example]').forEach((button) => {
    button.addEventListener('click', () => {
      state.example = button.dataset.example;
      render(true);
    });
  });
  const tabs = [...document.querySelectorAll('[data-language]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      language = tab.dataset.language;
      updateCode();
    });
    tab.addEventListener('keydown', (event) => {
      const next = {
        ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].click();
      tabs[next].focus();
    });
  });

  $('visibility').addEventListener('click', () => {
    stage.hidden = !stage.hidden;
    $('visibility').setAttribute('aria-expanded', String(!stage.hidden));
    $('visibility').textContent = stage.hidden ? 'Show preview' : 'Hide preview';
    updateSummary();
  });

  async function copy(text, label) {
    copiedText = text;
    $('copy-fallback').hidden = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (copiedText === text) $('copy-status').textContent = `${label} copied.`;
    } catch {
      if (copiedText !== text) return;
      $('fallback-code').value = text;
      $('copy-fallback').hidden = false;
      $('fallback-code').focus();
      $('fallback-code').select();
      $('copy-status').textContent = 'Code selected. Use your device’s copy command.';
    }
  }
  $('copy-tab').addEventListener('click', () => copy(snippets()[language], language.toUpperCase()));
  $('copy-full').addEventListener('click', () => copy(fullExample(), 'Full example'));
  new ResizeObserver(updateSummary).observe(sample);
  media.addEventListener('change', () => {
    updateMotionNote();
    updateSummary();
  });

  async function load() {
    if (loaded || loading) return;
    loading = true;
    $('load-error').hidden = true;
    $('load-message').hidden = false;
    stage.setAttribute('aria-busy', 'true');
    try {
      await import(CDN);
      await customElements.whenDefined('marquee-content');
      loaded = true;
      stage.setAttribute('aria-busy', 'false');
      $('load-message').hidden = true;
      sample.refresh();
    } catch {
      $('load-error').hidden = false;
      $('load-message').hidden = true;
    } finally {
      loading = false;
    }
  }
  $('retry').addEventListener('click', () => window.location.reload());
  render();
  load();
})();
