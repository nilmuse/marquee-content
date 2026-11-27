import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const files = new Map([
  ['/', new URL('./fixture.html', import.meta.url)],
  ['/dist/index.js', new URL('../../dist/index.js', import.meta.url)],
  ['/diagnostics/', new URL('../../demo/scroll-diagnostics/index.html', import.meta.url)],
  [
    '/diagnostics/recorder.js',
    new URL('../../demo/scroll-diagnostics/recorder.js', import.meta.url),
  ],
]);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const file = files.get(pathname);

  if (!file) {
    response.writeHead(404).end('Not found');
    return;
  }

  try {
    const contents = await readFile(file);
    response.writeHead(200, {
      'content-type': pathname.endsWith('.js') ? 'text/javascript' : 'text/html',
      'cache-control': 'no-store',
    });
    response.end(contents);
  } catch {
    response.writeHead(500).end('Build the package before running browser tests.');
  }
});

server.listen(4173, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close());
}
