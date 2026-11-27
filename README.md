# marquee-content

A Web Component for decorative text tickers, logo strips, and continuous image rows.

[![npm](https://img.shields.io/npm/v/marquee-content.svg?colorB=brightgreen)](https://www.npmjs.com/package/marquee-content)
[![NPM Downloads](https://img.shields.io/npm/dm/marquee-content.svg?style=flat)](https://www.npmjs.com/package/marquee-content)

[Demo](https://codepen.io/nilmuse/pen/dygzqYm)

## Installation

```bash
npm install marquee-content
```

## Quick start

Import the package in your browser entry point. This registers the default tag and installs its Shadow DOM styles:

```ts
import 'marquee-content';
```

```html
<marquee-content speed="120" direction="rtl">
  <span>News</span>
  <span>Promotions</span>
  <span>24/7 Delivery</span>
</marquee-content>
```

```css
marquee-content {
  --marquee-content-gap: 2rem;
  color: #151515;
  font: 600 2rem / 1.2 system-ui, sans-serif;
}
```

In the default `auto` mode, the row moves continuously using CSS animation. Layout updates automatically when source content, images, fonts, or sizes change.

## API

- `MarqueeContent` is the custom element class. Importing the main package automatically registers `<marquee-content>` in a browser.
- `defineMarqueeContent(tagName?, options?)` registers a tag if it is not already registered. The default name is `'marquee-content'`.
- `initMarqueeContents(options?)` accepts `tagName` alongside the global style options and delegates to `defineMarqueeContent()`.
- `MarqueeContent.configureStyles(options)`, `setStylesheet(value)`, and `setStyleOverrides(value)` configure shared component styles. See Styling for the available options.
- `MARQUEE_CONTENT_TAG` exports the default tag name.

```ts
import { defineMarqueeContent, initMarqueeContents } from 'marquee-content';

// Register an additional custom tag. The default tag remains registered.
defineMarqueeContent('brand-ticker');

// Equivalent registration helper, with global style configuration:
initMarqueeContents({
  tagName: 'brand-ticker',
  styleOverrides: ':host { --marquee-content-gap: 2.5rem; }',
});
```

Calling a registration helper is only needed for an additional tag or global style setup.

### Options

| Option (HTML / JavaScript) | Type | Default | Description |
| --- | --- | --- | --- |
| `speed` | `number` | `90` | Base speed in px/s, clamped to `10`–`500`. Independent of container width. |
| `mode` | `'auto' \| 'scroll'` | `'auto'` | `'auto'` for constant movement; `'scroll'` for page-scroll response and inertia. |
| `direction` | `'rtl' \| 'ltr'` | `'rtl'` | Base direction: right to left or left to right. |
| `pause-on-hover` / `pauseOnHover` | `boolean` | `false` | Pauses movement while the pointer is over the host. Items remain decorative and inert. |

Boolean attributes accept `true` or `false`; an empty attribute enables the option. Removing an attribute restores its default.

### Methods

```ts
import 'marquee-content';

const marquee = document.querySelector('marquee-content');

marquee?.update({
  mode: 'scroll',
  direction: 'ltr',
  speed: 120,
  pauseOnHover: true,
});

marquee?.refresh();
```

- `update(options)` applies options as attributes and updates the animation settings.
- `refresh()` schedules a fresh layout measurement. Use it after application-driven changes that need an explicit refresh.

## Scroll response

To react to page scrolling:

```html
<marquee-content speed="120" mode="scroll" direction="ltr">
  <span>New collection</span>
  <span>Made to move</span>
</marquee-content>
```

On devices with a fine pointer, `scroll` listens to the window's vertical scroll position. Its direction follows scrolling, and its speed boost decays after scrolling stops. A custom scroll container is not currently configurable.

On touch devices matching `(hover: none) and (pointer: coarse)`, `scroll` follows the scrolling direction at the configured constant speed, without acceleration or decay. Movement continues in the last direction after scrolling stops. The `direction` option determines the base direction, as on desktop. Direction changes preserve the current position and use a native CSS animation without a JavaScript frame loop. The component responds to changes in the input capabilities.

Elastic rebound after scrolling beyond a page edge does not reverse the marquee. A deliberate reverse gesture can change direction during rebound. Moving a finger or scrolling a nested container without page movement does not change the marquee direction.

For touch gestures that start at a page edge, viewport resizing after release preserves the gesture direction. Gestures starting inside the page continue to follow page movement during viewport changes. A new touch gesture resumes normal direction changes immediately.

While speed is changing on a fine-pointer device, `scroll` updates the track's transform on animation frames. Once speed settles, it returns to the Web Animations API and stops the JavaScript frame loop.

## Vue 3 with Vite

Tell Vue's compiler to treat the tag as a custom element:

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'marquee-content',
        },
      },
    }),
  ],
});
```

Then render it in a component:

```vue
<script setup lang="ts">
import 'marquee-content';
</script>

<template>
  <marquee-content speed="120">
    <span>New collection</span>
    <span>Made to move</span>
  </marquee-content>
</template>
```

## Styling

Base styles ship in the JavaScript bundle and are adopted into each component's Shadow DOM. No separate CSS import is required. A sidecar stylesheet is also exported as `marquee-content/marquee-content.css` for tooling that needs it.

### Inherited text styles and spacing

Set inherited properties such as `font` and `color` on the host. Set the gap through its CSS variable:

```css
.announcements {
  --marquee-content-gap: 1.5rem;
  color: #4a245f;
  font: 700 1.75rem / 1.2 system-ui, sans-serif;
}
```

| CSS variable | Purpose |
| --- | --- |
| `--marquee-content-gap` | Spacing between items, including the loop boundary. Default: `2rem`. |
| `--marquee-content-distance` | Measured loop distance, written by the component at runtime. |
| `--marquee-content-duration` | Calculated loop duration, written by the component at runtime. |

Use `speed` to control movement. The distance and duration variables expose calculated values rather than configuration inputs.

### CSS parts and custom item tokens

Rendered items live in Shadow DOM. Use the exposed parts to style them:

| Part | Target |
| --- | --- |
| `item` | Every copied top-level source element. |
| `group` | Each repeated group of content. |
| `viewport` | The container that clips the moving row. |
| `track` | The animated carrier of the groups. |

The default stylesheet uses `will-change: transform` on repeated groups as a [Safari loop-flicker workaround](https://bugs.webkit.org/show_bug.cgi?id=269284); reduced motion clears this hint. Each group therefore creates a stacking context and a containing block for positioned descendants. Individual items do not receive this hint.

A source element's existing `part` tokens are preserved alongside `item`, so individual items can have their own styles:

```html
<marquee-content class="brands" aria-label="Featured brands">
  <img src="/logos/presto.svg" part="presto" alt="Presto" width="140" height="48">
  <img src="/logos/acme.svg" part="acme" alt="Acme" width="120" height="48">
</marquee-content>
```

```css
.brands {
  --marquee-content-gap: 3rem;
}

.brands::part(item) {
  width: auto;
  height: 3rem;
  object-fit: contain;
}

.brands::part(presto) {
  height: 2.5rem;
}
```

Provide image dimensions to reserve space while images load. For a purely decorative image with no information to announce, use `alt=""`.

### Global runtime styles

Use `MarqueeContent.configureStyles()` to change styles for all existing and future instances:

```ts
import { MarqueeContent } from 'marquee-content';

MarqueeContent.configureStyles({
  styleOverrides: `
    :host { --marquee-content-gap: 1.25rem; }
    [part~="item"] { opacity: 0.85; }
  `,
});
```

| Style option | Type | Behavior |
| --- | --- | --- |
| `stylesheet` | `string \| CSSStyleSheet \| null` | Replaces the base stylesheet. `null` restores the bundled base stylesheet. |
| `styleOverrides` | `string \| CSSStyleSheet \| null` | Adds styles after the base stylesheet. `null` removes the overrides. |

Use host styles and `::part()` for individual instances. The runtime configuration above is shared globally.

## Supported content

Use the component for decorative text and images. The rendered row consists of copies of the supplied content; those copies are hidden from assistive technology and inert. Keep links, buttons, forms, and other interactive controls outside the moving row.

Apply text styles to the host and item styles through the exposed CSS parts. The component copies markup, including custom `part` tokens; event listeners, application state, and document-level class selectors are not a styling or interaction contract for the rendered copies.

## Accessibility and motion

- Source content remains available to assistive technology once; repeated visual copies are `aria-hidden` and inert.
- Use meaningful image `alt` text for informative logos and an empty `alt` for decorative images.
- `prefers-reduced-motion: reduce` presents one static, wrapping set of the content so all items can be seen without animation. CSS parts continue to apply.
- Movement pauses outside the viewport, on focus within the component, and on hover when `pause-on-hover` is enabled.

## Server-rendered applications

The module can be imported when browser globals are unavailable. Custom element registration and construction require a browser. Render the declarative tag in server-generated HTML and ensure the package also runs in the browser entry point; the animated Shadow DOM track is built there.

## Browser support

The component uses Custom Elements, Shadow DOM, constructable/adopted stylesheets, ResizeObserver, IntersectionObserver, and `inert`. The `scroll` mode also uses the Web Animations API. Use a browser that supports these APIs; legacy-browser fallbacks are not included.

Safari can [throttle animation-frame callbacks in cross-origin iframes until user interaction](https://bugs.webkit.org/show_bug.cgi?id=213344); a swipe may not release the limit. [CodePen Full Page uses an iframe](https://blog.codepen.io/documentation/full-page-view/), so compare `scroll` performance in Debug View or a standalone page with `<meta name="viewport" content="width=device-width, initial-scale=1">`.

## License

MIT
