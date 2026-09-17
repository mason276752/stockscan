// Idle-time prefetching: work the page will probably need next (the score
// and indicators of the company on screen, the neighbouring filings, the
// static build's indexes) is queued here and run one task at a time while
// the browser is idle and nothing the user asked for is loading. A task is
// an async function; what it fetches lands in the same caches the real
// request would use (memo.js, Cache Storage, the server's), so the later
// click is answered from there.
//
//   prefetch(key, task, { tag, priority, delay })
//     key       dedupes: a key that already ran (or is queued) is ignored
//     tag       drop(tag) discards the queued tasks of that tag (the company
//               changed: its neighbours are no longer likely)
//     priority  higher runs first; equal priority runs in order
//     delay     ms before the task becomes eligible (a dwell: skipped when
//               the user leaves before then)
//   setBusy(fn) fn() true while a user-requested load is in flight: the
//               queue waits
const queue = [];
const done = new Set();
let running = false;
let busy = () => false;
let seq = 0;

const saveData = typeof navigator !== 'undefined' && navigator.connection?.saveData;
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 300));

export function setBusy(fn) {
  busy = fn;
}

export function prefetch(key, task, { tag = null, priority = 0, delay = 0 } = {}) {
  if (saveData || done.has(key) || queue.some((q) => q.key === key)) return;
  queue.push({ key, task, tag, priority, at: Date.now() + delay, seq: seq++ });
  pump();
}

export function drop(tag) {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].tag === tag) queue.splice(i, 1);
}

function next() {
  const now = Date.now();
  const ready = queue.filter((q) => q.at <= now);
  if (!ready.length) return null;
  ready.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  return ready[0];
}

function pump() {
  if (running || !queue.length) return;
  running = true;
  idle(async () => {
    try {
      if (busy()) return; // a real load is going on: look again shortly
      const q = next();
      if (!q) return;
      queue.splice(queue.indexOf(q), 1);
      done.add(q.key);
      try {
        console.debug(`prefetch: ${q.key}`);
        await q.task();
      } catch {
        done.delete(q.key); // failed: may be retried by a later call
      }
    } finally {
      running = false;
      if (queue.length) setTimeout(pump, busy() ? 400 : 50);
    }
  });
}
