import {
  type MarqueeContentStyleEntry,
  type MarqueeContentStyleInput,
  marqueeContentCssText,
  normalizeStyleInput,
} from './styles';

export type MarqueeContentDirection = 'rtl' | 'ltr';
export type MarqueeContentMode = 'auto' | 'scroll';

export interface MarqueeContentOptions {
  speed?: number | string | null;
  mode?: MarqueeContentMode | null;
  direction?: MarqueeContentDirection | null;
  pauseOnHover?: boolean | string | null;
  responsiveSpeed?: boolean | string | null;
}

interface MarqueeContentResolvedOptions {
  speed: number;
  mode: MarqueeContentMode;
  direction: MarqueeContentDirection;
  minGroupWidthRatio: number;

  responsiveSpeed: boolean;
  referenceWidth: number;
  minSpeedFactor: number;
  maxSpeedFactor: number;

  pauseOnHover: boolean;
  pauseWhenOutOfView: boolean;
  recalculateAfterFontsReady: boolean;

  scrollVelocityFactor: number;
  scrollMinExtraSpeed: number;
  scrollMaxExtraSpeed: number;
  scrollInertiaDuration: number;
}

export interface DefineMarqueeContentOptions {
  stylesheet?: MarqueeContentStyleInput;
  styleOverrides?: MarqueeContentStyleInput;
}

export interface InitMarqueeContentsOptions extends DefineMarqueeContentOptions {
  tagName?: string;
}

export const MARQUEE_CONTENT_TAG = 'marquee-content';

const DEFAULT_OPTIONS: MarqueeContentResolvedOptions = {
  speed: 90,
  mode: 'auto',
  direction: 'rtl',
  minGroupWidthRatio: 1.05,

  responsiveSpeed: true,
  referenceWidth: 1280,
  minSpeedFactor: 0.55,
  maxSpeedFactor: 1,

  pauseOnHover: false,
  pauseWhenOutOfView: true,
  recalculateAfterFontsReady: true,

  scrollVelocityFactor: 150,
  scrollMinExtraSpeed: 0.05,
  scrollMaxExtraSpeed: 5,
  scrollInertiaDuration: 2500,
};

const OBSERVED_ATTRIBUTES = [
  'speed',
  'mode',
  'direction',
  'pause-on-hover',
  'responsive-speed',
] as const;

const OPTION_ATTRIBUTE_MAP: Record<keyof MarqueeContentOptions, string> = {
  speed: 'speed',
  mode: 'mode',
  direction: 'direction',
  pauseOnHover: 'pause-on-hover',
  responsiveSpeed: 'responsive-speed',
};

const MARQUEE_CONTENT_CSS_PROPS = [
  '--marquee-content-distance',
  '--marquee-content-duration',
] as const;

const SCROLL_TIME_SCALE_SMOOTHING_SECONDS = 0.12;

// Server imports do not need a DOM; element construction still requires a browser.
const HTMLElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

const MARQUEE_CONTENT_RUNTIME_CSS = `
  @keyframes marquee-content-auto {
    to {
      transform: translate3d(calc(-1 * var(--marquee-content-distance)), 0, 0);
    }
  }

  .marquee-content__source {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
  }

  .marquee-content__source::slotted(*) {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
`;

const TEMPLATE = `
  <slot class="marquee-content__source"></slot>

  <div class="marquee-content__viewport" part="viewport">
    <div class="marquee-content__track" part="track" aria-hidden="true" inert></div>
  </div>
`;

export class MarqueeContent extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return [...OBSERVED_ATTRIBUTES];
  }

  private static readonly instances = new Set<MarqueeContent>();

  private static readonly runtimeStylesheetEntry: MarqueeContentStyleEntry = normalizeStyleInput(
    MARQUEE_CONTENT_RUNTIME_CSS,
  );

  private static stylesheetEntry: MarqueeContentStyleEntry =
    normalizeStyleInput(marqueeContentCssText);

  private static styleOverridesEntry: MarqueeContentStyleEntry = normalizeStyleInput(null);

  static configureStyles(options: DefineMarqueeContentOptions = {}): void {
    if (!('stylesheet' in options) && !('styleOverrides' in options)) {
      return;
    }

    if ('stylesheet' in options) {
      MarqueeContent.stylesheetEntry = normalizeStyleInput(
        options.stylesheet ?? marqueeContentCssText,
      );
    }

    if ('styleOverrides' in options) {
      MarqueeContent.styleOverridesEntry = normalizeStyleInput(options.styleOverrides);
    }

    MarqueeContent.instances.forEach((instance) => {
      instance.applyAllStyles();
      instance.scheduleRebuild();
    });
  }

  static setStylesheet(stylesheet: MarqueeContentStyleInput): void {
    MarqueeContent.configureStyles({ stylesheet });
  }

  static setStyleOverrides(styleOverrides: MarqueeContentStyleInput): void {
    MarqueeContent.configureStyles({ styleOverrides });
  }

  private readonly shadow: ShadowRoot;
  private readonly sourceSlot: HTMLSlotElement;
  private readonly track: HTMLElement;

  private options: MarqueeContentResolvedOptions = { ...DEFAULT_OPTIONS };
  private sourceNodes: Node[] = [];

  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private abortController: AbortController | null = null;
  private reducedMotionMediaQuery: MediaQueryList | null = null;

  private animationFrameId: number | null = null;
  private rebuildFrameId: number | null = null;
  private lastFrameTime: number | null = null;

  private mounted = false;
  private isHovered = false;
  private isFocused = false;
  private isInViewport = true;
  private reducedMotion = false;
  private isListeningToScroll = false;

  private distance = 0;
  private containerWidth = 0;
  private group: HTMLElement | null = null;
  private layoutPhase: 'source' | 'copies' | null = null;

  private scrollAnimation: Animation | null = null;
  private scrollAnimationDuration = 0;
  private scrollAnimationDistance = 0;
  private scrollProgress = 0;

  private scrollDirectionFactor: 1 | -1 = 1;
  private currentTimeScale = 1;
  private scrollBoostStartValue = 0;
  private scrollBoostStartedAt = 0;
  private lastScrollY = 0;
  private lastScrollTime = 0;

  constructor() {
    if (typeof HTMLElement === 'undefined') {
      throw new Error(
        '[MarqueeContent] Create elements in a browser, after client initialization.',
      );
    }

    super();

    this.shadow = this.attachShadow({ mode: 'open' });
    this.applyAllStyles();

    const template = document.createElement('template');
    template.innerHTML = TEMPLATE;
    this.shadow.appendChild(template.content.cloneNode(true));

    const sourceSlot = this.shadow.querySelector<HTMLSlotElement>('slot.marquee-content__source');

    const track = this.shadow.querySelector<HTMLElement>('.marquee-content__track');

    if (!sourceSlot) {
      throw new Error('[MarqueeContent] Source slot was not found.');
    }

    if (!track) {
      throw new Error('[MarqueeContent] Track element was not found.');
    }

    this.sourceSlot = sourceSlot;
    this.track = track;
  }

  connectedCallback(): void {
    if (this.mounted) {
      return;
    }

    MarqueeContent.instances.add(this);

    this.mounted = true;
    this.applyAllStyles();
    this.abortController = new AbortController();
    this.options = this.resolveOptions();

    this.lastScrollY = this.getScrollY();
    this.lastScrollTime = performance.now();

    this.sourceSlot.addEventListener('slotchange', this.handleSlotChange, {
      signal: this.abortController.signal,
    });

    // Only source loads should rebuild the track, never loads from its decorative copies.
    for (const eventName of ['load', 'error']) {
      this.addEventListener(eventName, this.handleSourceLoad, {
        capture: true,
        signal: this.abortController.signal,
      });
      this.shadow.addEventListener(eventName, this.completeLayout, {
        capture: true,
        signal: this.abortController.signal,
      });
    }

    this.addEventListener('pointerenter', this.handlePointerEnter, {
      signal: this.abortController.signal,
    });

    this.addEventListener('pointerleave', this.handlePointerLeave, {
      signal: this.abortController.signal,
    });

    this.addEventListener('focusin', this.handleFocusIn, {
      signal: this.abortController.signal,
    });

    this.addEventListener('focusout', this.handleFocusOut, {
      signal: this.abortController.signal,
    });

    window.addEventListener('orientationchange', this.scheduleRebuild, {
      signal: this.abortController.signal,
    });

    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(this);

    this.intersectionObserver = new IntersectionObserver(this.handleIntersectionChange);
    this.intersectionObserver.observe(this);

    this.setupReducedMotionWatcher();
    this.watchSourceNodes();
    this.updateScrollListener();
    this.rebuild();

    if (this.options.recalculateAfterFontsReady) {
      this.rebuildAfterFontsReady();
    }
  }

  disconnectedCallback(): void {
    this.teardown();
    MarqueeContent.instances.delete(this);
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) {
      return;
    }

    this.options = this.resolveOptions();

    if (!this.mounted) {
      return;
    }

    this.updateScrollListener();
    this.applyOptions();
  }

  get speed(): number {
    return this.options.speed;
  }

  set speed(value: number | string | null | undefined) {
    this.setNullableAttribute('speed', value);
  }

  get mode(): MarqueeContentMode {
    return this.options.mode;
  }

  set mode(value: MarqueeContentMode | null | undefined) {
    this.setNullableAttribute('mode', value);
  }

  get direction(): MarqueeContentDirection {
    return this.options.direction;
  }

  set direction(value: MarqueeContentDirection | null | undefined) {
    this.setNullableAttribute('direction', value);
  }

  get pauseOnHover(): boolean {
    return this.options.pauseOnHover;
  }

  set pauseOnHover(value: boolean | string | null | undefined) {
    this.setNullableAttribute('pause-on-hover', value);
  }

  get responsiveSpeed(): boolean {
    return this.options.responsiveSpeed;
  }

  set responsiveSpeed(value: boolean | string | null | undefined) {
    this.setNullableAttribute('responsive-speed', value);
  }

  update(options: MarqueeContentOptions = {}): void {
    Object.entries(options).forEach(([key, value]) => {
      const attributeName = OPTION_ATTRIBUTE_MAP[key as keyof MarqueeContentOptions];

      if (attributeName) {
        this.setNullableAttribute(attributeName, value);
      }
    });

    this.options = this.resolveOptions();
    this.updateScrollListener();
    this.applyOptions();
  }

  refresh(): void {
    this.scheduleRebuild();
  }

  private applyAllStyles(): void {
    const runtime = MarqueeContent.runtimeStylesheetEntry;
    const base = MarqueeContent.stylesheetEntry;
    const overrides = MarqueeContent.styleOverridesEntry;
    const sheets: CSSStyleSheet[] = [];

    if (runtime.sheet) {
      sheets.push(runtime.sheet);
    }

    if (base.sheet) {
      sheets.push(base.sheet);
    }

    if (overrides.sheet) {
      sheets.push(overrides.sheet);
    }

    this.shadow.adoptedStyleSheets = sheets;
  }

  private teardown(): void {
    if (!this.mounted) {
      return;
    }

    this.mounted = false;

    this.stopAnimationLoop();
    this.stopCssAnimation();
    this.cancelScrollAnimation();
    this.cancelScheduledRebuild();
    this.updateScrollListener(false);

    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.intersectionObserver?.disconnect();

    this.removeReducedMotionWatcher();

    this.abortController?.abort();

    this.group = null;
    this.layoutPhase = null;
    this.containerWidth = 0;
    this.resizeObserver = null;
    this.mutationObserver = null;
    this.intersectionObserver = null;
    this.abortController = null;

    this.track.replaceChildren();
    this.removeAttribute('data-marquee-content-ready');
    this.removeAttribute('data-marquee-content-mode');
    this.removeAttribute('data-marquee-content-pause-on-hover');
    this.removeAttribute('data-marquee-content-reduced-motion');

    MARQUEE_CONTENT_CSS_PROPS.forEach((prop) => {
      this.style.removeProperty(prop);
    });

    this.distance = 0;
    this.isHovered = false;
    this.isFocused = false;
    this.isInViewport = true;
    this.scrollDirectionFactor = 1;
    this.scrollBoostStartValue = 0;
    this.scrollBoostStartedAt = 0;
    this.scrollProgress = 0;
    this.currentTimeScale = 1;
    this.lastFrameTime = null;
  }

  private handleResize = (): void => {
    if (
      this.clientWidth !== this.containerWidth ||
      (this.group &&
        this.layoutPhase === null &&
        Math.abs(this.measureGroup(this.group) - this.distance) > 0.01)
    ) {
      this.scheduleRebuild();
    }
  };

  private handleSourceLoad = (event: Event): void => {
    // A shadow-tree event may be retargeted to the host; only authored descendants count.
    if (event.target instanceof Node && event.target !== this && this.contains(event.target)) {
      this.scheduleRebuild();
    }
  };

  private handleSlotChange = (): void => {
    this.watchSourceNodes();
    this.scheduleRebuild();
  };

  private handlePointerEnter = (): void => {
    this.isHovered = true;
    this.updateAnimationLoopState();
  };

  private handlePointerLeave = (): void => {
    this.isHovered = false;
    this.updateAnimationLoopState();
  };

  private handleFocusIn = (): void => {
    this.isFocused = true;
    this.updateAnimationLoopState();
  };

  private handleFocusOut = (): void => {
    this.isFocused = false;
    this.updateAnimationLoopState();
  };

  private handleIntersectionChange = (entries: IntersectionObserverEntry[]): void => {
    const entry = entries[0];

    if (!entry) {
      return;
    }

    this.isInViewport = entry.isIntersecting;
    this.updateAnimationLoopState();
  };

  private handleReducedMotionChange = (event: MediaQueryListEvent | MediaQueryList): void => {
    this.reducedMotion = event.matches;

    if (this.reducedMotion) {
      this.track.style.transform = 'none';
    } else if (this.options.mode === 'scroll') {
      this.track.style.transform = '';
    }

    this.updateAnimationLoopState();
    this.scheduleRebuild();
  };

  private handleScroll = (): void => {
    if (this.options.mode !== 'scroll') {
      return;
    }

    const now = performance.now();
    const currentScrollY = this.getScrollY();

    const deltaY = currentScrollY - this.lastScrollY;
    const deltaTime = Math.max((now - this.lastScrollTime) / 1000, 0.016);

    this.lastScrollY = currentScrollY;
    this.lastScrollTime = now;

    if (Math.abs(deltaY) < 0.5) {
      return;
    }

    const velocity = deltaY / deltaTime;

    this.scrollDirectionFactor = velocity >= 0 ? 1 : -1;

    const extraSpeed = this.clamp(
      velocity / this.options.scrollVelocityFactor,
      -this.options.scrollMaxExtraSpeed,
      this.options.scrollMaxExtraSpeed,
    );

    if (Math.abs(extraSpeed) >= this.options.scrollMinExtraSpeed) {
      this.scrollBoostStartValue = extraSpeed;
      this.scrollBoostStartedAt = now;
    } else {
      this.scrollBoostStartValue = 0;
    }

    this.onScrollBoostChanged();
  };

  private onScrollBoostChanged(): void {
    if (!this.mounted || this.options.mode !== 'scroll' || this.reducedMotion) {
      return;
    }

    this.ensureScrollAnimation();

    if (!this.scrollAnimation || !this.canAnimate()) {
      return;
    }

    this.scrollAnimation.play();
    this.startAnimationLoop();
  }

  private updateScrollListener(
    shouldListen = this.mounted && this.options.mode === 'scroll',
  ): void {
    if (shouldListen === this.isListeningToScroll) {
      return;
    }

    if (shouldListen) {
      this.lastScrollY = this.getScrollY();
      this.lastScrollTime = performance.now();
      window.addEventListener('scroll', this.handleScroll, { passive: true });
    } else {
      window.removeEventListener('scroll', this.handleScroll);
    }

    this.isListeningToScroll = shouldListen;
  }

  private scheduleRebuild = (): void => {
    if (!this.mounted) {
      return;
    }

    this.cancelScheduledRebuild();

    this.rebuildFrameId = requestAnimationFrame(() => {
      this.rebuildFrameId = null;
      this.rebuild();
    });
  };

  private cancelScheduledRebuild(): void {
    if (this.rebuildFrameId === null) {
      return;
    }

    cancelAnimationFrame(this.rebuildFrameId);
    this.rebuildFrameId = null;
  }

  private applyOptions(): void {
    if (!this.mounted) {
      return;
    }

    const progress = this.scrollAnimation
      ? this.getScrollAnimationProgress()
      : (this.getAutoAnimation()?.effect?.getComputedTiming().progress ?? this.scrollProgress);
    const duration = this.distance / this.getCurrentSpeed(this.clientWidth);

    this.setAttribute('data-marquee-content-mode', this.options.mode);
    this.toggleAttribute('data-marquee-content-pause-on-hover', this.options.pauseOnHover);
    this.toggleAttribute('data-marquee-content-reduced-motion', this.reducedMotion);

    if (this.distance > 0) {
      this.style.setProperty('--marquee-content-distance', `${this.distance}px`);
      this.style.setProperty('--marquee-content-duration', `${duration}s`);
    }

    if (progress != null) {
      this.scrollProgress = progress;
    }

    this.updateAnimationLoopState();

    if (progress != null && this.options.mode === 'auto' && !this.reducedMotion) {
      const animation = this.getAutoAnimation();

      if (animation) {
        animation.currentTime =
          duration * 1000 * (this.options.direction === 'ltr' ? 1 - progress : progress);
      }
    }
  }

  private getAutoAnimation(): Animation | undefined {
    return this.track
      .getAnimations()
      .find(
        (animation) =>
          'animationName' in animation && animation.animationName === 'marquee-content-auto',
      );
  }

  private rebuild(): void {
    if (!this.mounted) {
      return;
    }

    this.options = this.resolveOptions();
    this.updateScrollListener();
    const progress = this.scrollAnimation
      ? this.getScrollAnimationProgress()
      : this.getAutoAnimation()?.effect?.getComputedTiming().progress;

    if (progress != null) {
      this.scrollProgress = progress;
    }

    this.distance = 0;
    this.layoutPhase = null;
    this.updateAnimationLoopState();
    this.removeAttribute('data-marquee-content-ready');
    this.toggleAttribute('data-marquee-content-reduced-motion', this.reducedMotion);
    this.containerWidth = this.clientWidth;

    if (this.group) {
      this.resizeObserver?.unobserve(this.group);
      this.group = null;
    }

    this.sourceNodes = this.getSourceNodes();

    if (this.containerWidth <= 0 || this.sourceNodes.length === 0) {
      this.distance = 0;
      this.track.replaceChildren();
      this.applyOptions();
      return;
    }

    this.group = this.createGroup();
    this.track.replaceChildren(this.group);
    this.layoutPhase = 'source';
    this.completeLayout();
  }

  private completeLayout = (): void => {
    const group = this.group;

    if (!this.mounted || !group || this.layoutPhase === null) {
      return;
    }

    // Firefox can load a cached clone asynchronously. Measure its real intrinsic size first,
    // then finish the repeated copies without replacing the already loaded source group.
    if (this.hasPendingImages(this.track)) {
      return;
    }

    if (this.layoutPhase === 'source') {
      this.layoutPhase = 'copies';

      if (!this.reducedMotion) {
        this.expandGroupToWidth(group, this.containerWidth * this.options.minGroupWidthRatio);
        this.track.appendChild(group.cloneNode(true));
      }

      if (this.hasPendingImages(this.track)) {
        return;
      }
    }

    this.layoutPhase = null;
    this.distance = this.measureGroup(group);
    this.resizeObserver?.observe(group);

    if (this.distance <= 0) {
      this.track.replaceChildren();
      this.applyOptions();
      return;
    }

    this.setAttribute('data-marquee-content-ready', 'true');
    this.applyOptions();
  };

  private hasPendingImages(root: ParentNode): boolean {
    return Array.from(root.querySelectorAll('img')).some((image) => !image.complete);
  }

  private measureGroup(group: HTMLElement): number {
    const style = getComputedStyle(group);
    const width = Number.parseFloat(style.width);

    if (!Number.isFinite(width)) {
      return group.scrollWidth;
    }

    if (style.boxSizing === 'border-box') {
      return width;
    }

    return (
      width +
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight) +
      Number.parseFloat(style.borderLeftWidth) +
      Number.parseFloat(style.borderRightWidth)
    );
  }

  private createGroup(): HTMLElement {
    const group = document.createElement('div');

    group.className = 'marquee-content__group';
    group.setAttribute('part', 'group');

    this.appendSourceNodes(group);

    return group;
  }

  private expandGroupToWidth(group: HTMLElement, targetWidth: number): void {
    const sourceSetWidth = this.measureGroup(group);

    if (sourceSetWidth <= 0) {
      return;
    }

    const repeatCount = Math.ceil(targetWidth / sourceSetWidth);

    for (let index = 1; index < repeatCount; index += 1) {
      this.appendSourceNodes(group);
    }
  }

  private appendSourceNodes(target: HTMLElement): void {
    const fragment = document.createDocumentFragment();

    this.sourceNodes.forEach((node) => {
      fragment.append(this.cloneSourceNode(node));
    });

    target.appendChild(fragment);
  }

  private cloneSourceNode(node: Node): Node {
    const clone = node.cloneNode(true);

    if (clone instanceof Element) {
      const currentPart = clone.getAttribute('part');

      clone.setAttribute('part', currentPart ? `${currentPart} item` : 'item');

      // Offscreen lazy copies still need intrinsic dimensions before the loop can be measured.
      if (clone instanceof HTMLImageElement) {
        clone.loading = 'eager';
      }

      clone.querySelectorAll('img').forEach((image) => {
        image.loading = 'eager';
      });
    }

    return clone;
  }

  private getSourceNodes(): Node[] {
    return this.sourceSlot.assignedNodes({ flatten: true }).filter((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return Boolean(node.textContent?.trim());
      }

      return node.nodeType === Node.ELEMENT_NODE;
    });
  }

  private watchSourceNodes(): void {
    this.mutationObserver?.disconnect();

    this.mutationObserver = new MutationObserver(this.scheduleRebuild);

    this.sourceSlot.assignedNodes({ flatten: true }).forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        this.mutationObserver?.observe(node, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });

        return;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        this.mutationObserver?.observe(node, {
          characterData: true,
        });
      }
    });
  }

  private setupReducedMotionWatcher(): void {
    if (!('matchMedia' in window)) {
      return;
    }

    this.reducedMotionMediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    this.reducedMotion = this.reducedMotionMediaQuery.matches;
    this.reducedMotionMediaQuery.addEventListener('change', this.handleReducedMotionChange, {
      signal: this.abortController?.signal,
    });
  }

  private removeReducedMotionWatcher(): void {
    if (!this.reducedMotionMediaQuery) {
      return;
    }

    this.reducedMotionMediaQuery.removeEventListener('change', this.handleReducedMotionChange);

    this.reducedMotionMediaQuery = null;
  }

  private updateAnimationLoopState(): void {
    if (!this.mounted || this.distance <= 0 || this.reducedMotion) {
      this.stopAnimationLoop();
      this.stopCssAnimation();
      this.cancelScrollAnimation();

      if (this.reducedMotion) {
        this.track.style.transform = 'none';
      }

      return;
    }

    if (this.options.mode === 'scroll') {
      this.stopCssAnimation();
      this.track.style.transform = '';
      this.ensureScrollAnimation();

      if (!this.scrollAnimation || !this.canAnimate()) {
        this.scrollAnimation?.pause();
        this.stopAnimationLoop();
        return;
      }

      this.scrollAnimation.play();
      this.updateScrollPlaybackRate(performance.now(), true);
      this.startAnimationLoop();

      return;
    }

    this.stopAnimationLoop();
    this.cancelScrollAnimation();
    this.startCssAnimation();
    this.track.style.animationPlayState = this.canAnimate() ? 'running' : 'paused';
  }

  private canAnimate(): boolean {
    if (this.options.pauseOnHover && this.isHovered) {
      return false;
    }

    if (this.isFocused) {
      return false;
    }

    if (this.options.pauseWhenOutOfView && !this.isInViewport) {
      return false;
    }

    return true;
  }

  private startAnimationLoop(): void {
    if (this.animationFrameId !== null) {
      return;
    }

    this.lastFrameTime = performance.now();
    this.animationFrameId = requestAnimationFrame(this.tick);
  }

  private stopAnimationLoop(): void {
    if (this.animationFrameId === null) {
      this.lastFrameTime = null;
      return;
    }

    cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = null;
    this.lastFrameTime = null;
  }

  private startCssAnimation(): void {
    const animationDirection = this.options.direction === 'ltr' ? 'reverse' : 'normal';

    this.track.style.transform = '';

    if (this.track.style.animationName !== 'marquee-content-auto') {
      this.track.style.animationName = 'marquee-content-auto';
      this.track.style.animationDuration = 'var(--marquee-content-duration)';
      this.track.style.animationTimingFunction = 'linear';
      this.track.style.animationIterationCount = 'infinite';
    }

    if (this.track.style.animationDirection !== animationDirection) {
      this.track.style.animationDirection = animationDirection;
    }
  }

  private stopCssAnimation(): void {
    this.track.style.animationName = '';
    this.track.style.animationDuration = '';
    this.track.style.animationTimingFunction = '';
    this.track.style.animationIterationCount = '';
    this.track.style.animationDirection = '';
    this.track.style.animationPlayState = '';
  }

  private tick = (now: number): void => {
    this.animationFrameId = null;

    if (
      !this.mounted ||
      this.options.mode !== 'scroll' ||
      this.distance <= 0 ||
      this.reducedMotion ||
      !this.canAnimate() ||
      !this.scrollAnimation
    ) {
      return;
    }

    const settled = this.updateScrollPlaybackRate(now, false);

    if (!settled) {
      this.animationFrameId = requestAnimationFrame(this.tick);
    }
  };

  private ensureScrollAnimation(): void {
    if (this.distance <= 0) {
      this.cancelScrollAnimation();
      return;
    }

    const currentSpeed = this.getCurrentSpeed(this.clientWidth);
    const durationMs = currentSpeed > 0 ? (this.distance / currentSpeed) * 1000 : 0;

    if (durationMs <= 0) {
      this.cancelScrollAnimation();
      return;
    }

    if (
      this.scrollAnimation &&
      this.scrollAnimationDistance === this.distance &&
      this.scrollAnimationDuration === durationMs
    ) {
      return;
    }

    const progress = this.getScrollAnimationProgress();
    const hadAnimation = this.scrollAnimation !== null;

    if (this.scrollAnimation) {
      this.scrollAnimation.cancel();
      this.scrollAnimation = null;
    }

    if (!hadAnimation) {
      this.currentTimeScale = this.getDirectionFactor() * this.scrollDirectionFactor;
    }

    const animation = this.track.animate(
      [
        { transform: 'translate3d(0px, 0, 0)' },
        { transform: `translate3d(${-this.distance}px, 0, 0)` },
      ],
      {
        duration: durationMs,
        iterations: Number.POSITIVE_INFINITY,
        easing: 'linear',
      },
    );

    // Reverse the effect while keeping time positive, so long-running motion cannot end at zero.
    const reversed = this.currentTimeScale < 0;
    animation.effect?.updateTiming({ direction: reversed ? 'reverse' : 'normal' });
    animation.currentTime = durationMs * (reversed ? 1 - progress : progress);
    animation.playbackRate = Math.abs(this.currentTimeScale);

    this.scrollAnimation = animation;
    this.scrollAnimationDuration = durationMs;
    this.scrollAnimationDistance = this.distance;
    this.scrollProgress = progress;
  }

  private cancelScrollAnimation(): void {
    if (!this.scrollAnimation) {
      return;
    }

    this.scrollProgress = this.getScrollAnimationProgress();
    this.scrollAnimation.cancel();
    this.scrollAnimation = null;
    this.scrollAnimationDuration = 0;
    this.scrollAnimationDistance = 0;
  }

  private getScrollAnimationProgress(): number {
    const animation = this.scrollAnimation;

    if (!animation || this.scrollAnimationDuration <= 0) {
      return this.scrollProgress;
    }

    const currentTime = animation.currentTime;

    if (typeof currentTime !== 'number') {
      return this.scrollProgress;
    }

    const fraction = (currentTime / this.scrollAnimationDuration) % 1;

    const progress = fraction < 0 ? fraction + 1 : fraction;

    return animation.effect?.getTiming().direction === 'reverse' ? (1 - progress) % 1 : progress;
  }

  private updateScrollPlaybackRate(now: number, immediate: boolean): boolean {
    if (!this.scrollAnimation) {
      return true;
    }

    const target = this.getCurrentTimeScale(now);

    if (immediate) {
      this.currentTimeScale = target;
      this.lastFrameTime = now;
    } else {
      const previousTime = this.lastFrameTime ?? now;
      const deltaTime = Math.min((now - previousTime) / 1000, 0.064);

      this.lastFrameTime = now;

      const smoothingFactor = 1 - Math.exp(-deltaTime / SCROLL_TIME_SCALE_SMOOTHING_SECONDS);

      this.currentTimeScale += (target - this.currentTimeScale) * smoothingFactor;
    }

    const settled =
      this.scrollBoostStartValue === 0 && Math.abs(target - this.currentTimeScale) < 0.001;

    if (settled) {
      this.currentTimeScale = target;
    }

    const reversed = this.currentTimeScale < 0;
    const effect = this.scrollAnimation.effect;

    if (effect && (effect.getTiming().direction === 'reverse') !== reversed) {
      const progress = this.getScrollAnimationProgress();
      effect.updateTiming({ direction: reversed ? 'reverse' : 'normal' });
      this.scrollAnimation.currentTime =
        this.scrollAnimationDuration * (reversed ? 1 - progress : progress);
    }

    const playbackRate = Math.abs(this.currentTimeScale);

    if (this.scrollAnimation.playbackRate !== playbackRate) {
      this.scrollAnimation.updatePlaybackRate(playbackRate);
    }

    return settled;
  }

  private getCurrentTimeScale(now: number): number {
    const directionFactor = this.getDirectionFactor();

    if (this.options.mode !== 'scroll') {
      return directionFactor;
    }

    const boost = this.getScrollBoost(now);
    const scrollTimeScale = this.scrollDirectionFactor + boost;

    return this.clamp(
      directionFactor * scrollTimeScale,
      -1 - this.options.scrollMaxExtraSpeed,
      1 + this.options.scrollMaxExtraSpeed,
    );
  }

  private getDirectionFactor(): 1 | -1 {
    return this.options.direction === 'ltr' ? -1 : 1;
  }

  private getScrollBoost(now: number): number {
    if (this.scrollBoostStartValue === 0) {
      return 0;
    }

    const duration = this.options.scrollInertiaDuration;

    if (duration <= 0) {
      this.scrollBoostStartValue = 0;
      return 0;
    }

    const progress = this.clamp((now - this.scrollBoostStartedAt) / duration, 0, 1);

    if (progress >= 1) {
      this.scrollBoostStartValue = 0;
      return 0;
    }

    const easedProgress = this.easeOutCubic(progress);

    return this.scrollBoostStartValue * (1 - easedProgress);
  }

  private getCurrentSpeed(containerWidth: number): number {
    if (!this.options.responsiveSpeed) {
      return this.options.speed;
    }

    const factor = this.clamp(
      containerWidth / this.options.referenceWidth,
      this.options.minSpeedFactor,
      this.options.maxSpeedFactor,
    );

    return this.options.speed * factor;
  }

  private resolveOptions(): MarqueeContentResolvedOptions {
    return {
      ...DEFAULT_OPTIONS,
      speed: this.num('speed', DEFAULT_OPTIONS.speed, 10, 500),
      mode: this.parseMode(this.getAttribute('mode'), DEFAULT_OPTIONS.mode),
      direction: this.parseDirection(this.getAttribute('direction'), DEFAULT_OPTIONS.direction),
      pauseOnHover: this.parseBoolean(
        this.getAttribute('pause-on-hover'),
        DEFAULT_OPTIONS.pauseOnHover,
      ),
      responsiveSpeed: this.parseBoolean(
        this.getAttribute('responsive-speed'),
        DEFAULT_OPTIONS.responsiveSpeed,
      ),
    };
  }

  private num(attributeName: string, fallback: number, min: number, max: number): number {
    return this.clamp(this.parseNumber(this.getAttribute(attributeName), fallback), min, max);
  }

  private parseNumber(value: string | null, fallback: number): number {
    if (value === null || value.trim() === '') {
      return fallback;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private parseBoolean(value: string | null, fallback: boolean): boolean {
    if (value === null) {
      return fallback;
    }

    const normalizedValue = value.trim().toLowerCase();

    if (normalizedValue === '') {
      return true;
    }

    if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
      return false;
    }

    return fallback;
  }

  private parseMode(value: string | null, fallback: MarqueeContentMode): MarqueeContentMode {
    if (value === 'auto' || value === 'scroll') {
      return value;
    }

    return fallback;
  }

  private parseDirection(
    value: string | null,
    fallback: MarqueeContentDirection,
  ): MarqueeContentDirection {
    if (value === 'rtl' || value === 'ltr') {
      return value;
    }

    return fallback;
  }

  private setNullableAttribute(
    name: string,
    value: string | number | boolean | null | undefined,
  ): void {
    if (value === null || value === undefined) {
      this.removeAttribute(name);
      return;
    }

    this.setAttribute(name, String(value));
  }

  private getScrollY(): number {
    return window.scrollY || window.pageYOffset || 0;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private easeOutCubic(value: number): number {
    return 1 - (1 - value) ** 3;
  }

  private rebuildAfterFontsReady(): void {
    const fonts = (
      document as Document & {
        fonts?: { ready: Promise<unknown> };
      }
    ).fonts;

    if (!fonts?.ready) {
      return;
    }

    void fonts.ready.then(this.scheduleRebuild).catch(() => undefined);
  }
}

export function defineMarqueeContent(
  tagName = MARQUEE_CONTENT_TAG,
  options: DefineMarqueeContentOptions = {},
): void {
  if (typeof window === 'undefined' || !window.customElements) {
    return;
  }

  MarqueeContent.configureStyles(options);

  if (!window.customElements.get(tagName)) {
    const elementClass =
      tagName === MARQUEE_CONTENT_TAG ? MarqueeContent : class extends MarqueeContent {};
    window.customElements.define(tagName, elementClass);
  }
}

export function initMarqueeContents(options: InitMarqueeContentsOptions = {}): void {
  const { tagName = MARQUEE_CONTENT_TAG, ...styleOptions } = options;

  defineMarqueeContent(tagName, styleOptions);
}

declare global {
  interface HTMLElementTagNameMap {
    'marquee-content': MarqueeContent;
  }
}
