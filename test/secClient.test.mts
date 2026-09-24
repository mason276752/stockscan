import test from 'node:test';
import assert from 'node:assert/strict';
import { SecClient } from '../server/lib/secClient.ts';

// The stamp below is taken inside fetch, a moment after the client's slot
// opened - and that moment is not the same for two requests (one may have a
// queue to set up, the next none). So a pair of stamps can read a fraction
// of a millisecond under the interval the client really waited; the test
// allows for that without allowing a missing wait, which would be ~0 ms.
const EPS = 1;

// every request that leaves for sec.gov, in order, with no network
async function stamps(run) {
  const at = [];
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    at.push(performance.now());
    return new Response('ok', { status: 200 });
  };
  try {
    await run(new SecClient({ userAgent: 'stockscan test test@example.com' }));
  } finally {
    globalThis.fetch = real;
  }
  return at.slice(1).map((t, i) => t - at[i]);
}

test('sec.gov requests are at least 101 ms apart, however they are issued', async () => {
  // twelve at once: the client queues them, MAX_IN_FLIGHT does not let them bunch up
  const parallel = await stamps((c) => Promise.all(Array.from({ length: 12 }, (_, i) => c.text(`https://www.sec.gov/parallel/${i}`))));
  assert.equal(parallel.length, 11);
  for (const gap of parallel) assert.ok(gap >= 101 - EPS, `gap ${gap.toFixed(1)} ms < 101 ms`);

  // and mixed priorities one after another (the crawler's low-priority work
  // next to a user request)
  const mixed = await stamps(async (c) => {
    const low = c.lowPriority();
    await Promise.all([c.text('https://www.sec.gov/user/1'), low.text('https://www.sec.gov/crawl/1'), c.text('https://www.sec.gov/user/2'), low.text('https://www.sec.gov/crawl/2')]);
  });
  for (const gap of mixed) assert.ok(gap >= 101 - EPS, `gap ${gap.toFixed(1)} ms < 101 ms`);
});

test('a retry waits its turn too', async () => {
  const at = [];
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    at.push(performance.now());
    return new Response('', { status: ++n === 1 ? 503 : 200 }); // the first attempt is retried
  };
  try {
    const c = new SecClient({ userAgent: 'stockscan test test@example.com' });
    await c.text('https://www.sec.gov/retry');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 101 - EPS, `retry came ${(at[1] - at[0]).toFixed(1)} ms after the first attempt`);
});
