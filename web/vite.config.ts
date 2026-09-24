import { defineConfig } from 'vite';
import type { HtmlTagDescriptor, IndexHtmlTransformResult, Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

// BASE_URL (same variable as the server): dev server and proxy live under the
// prefix too, so `BASE_URL=/stockscan npm run dev` mirrors production. The
// production build always uses relative asset URLs and takes the prefix from
// the server at runtime, so one build serves any BASE_URL.
const base = `/${String(process.env.BASE_URL || '').trim().replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
const backend = process.env.VITE_BACKEND || 'http://localhost:3000';

// The static build's page can start fetching the data worker and the zstd
// decoder while the app's own script is still loading: both are on the way
// to any data, and a slow connection pays for each hop in the chain.
const preloadWorker = (): Plugin => ({
  name: 'stockscan-preload-worker',
  transformIndexHtml: {
    order: 'post',
    handler(_html: string, ctx: { bundle?: Record<string, unknown> }): IndexHtmlTransformResult {
      if (!ctx.bundle) return [];
      const names = Object.keys(ctx.bundle);
      const worker = names.find((n) => /api\.static\.worker-[\w-]+\.js$/.test(n));
      const wasm = names.find((n) => /zstd-[\w-]+\.wasm$/.test(n));
      return [
        ...(worker ? [{ tag: 'link', attrs: { rel: 'modulepreload', href: `./${worker}` }, injectTo: 'head' } satisfies HtmlTagDescriptor] : []),
        ...(wasm ? [{ tag: 'link', attrs: { rel: 'preload', as: 'fetch', href: `./${wasm}`, crossorigin: '' }, injectTo: 'head' } satisfies HtmlTagDescriptor] : []),
      ];
    },
  },
});

export default defineConfig(({ command }) => ({
  plugins: [vue(), ...(process.env.VITE_STATIC === '1' ? [preloadWorker()] : [])],
  base: command === 'build' ? './' : `${base}/`,
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/api', '/tradingview'].map((p) => [`${base}${p}`, backend])) as Record<string, string>,
  },
}));
