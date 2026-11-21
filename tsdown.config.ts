import { defineCssLibrary } from '@nilmuse/tsdown-config';

export default defineCssLibrary({
  cssFileName: 'marquee-content.css',
  platform: 'browser',
  entry: { index: 'src/index.ts' },
});
