// Idle-time prefetch: when the user looks at a filing, quietly download the
// filings around it (previous/next in time, the same quarter a year earlier
// and later, and the rest of that fiscal year so the Q4 derivation is
// instant). Runs one filing at a time, only while the SEC client is idle.

import { scrapeFiling, isCached } from './scrape.ts';
import { store } from './store.ts';
import type { SecClient } from './secClient.ts';
import type { Company, FilingRef } from './types.ts';
import type { ScrapableFiling } from './scrape.ts';

const QUEUE_CAP = 60;

/** What the status endpoint reports about the prefetcher. */
export interface PrefetchStatus {
  queued: number;
  current: string | null;
  done: number;
  failed: number;
}

export interface Prefetcher {
  schedule(company: Company, filing: FilingRef): void;
  status(): PrefetchStatus;
}

export function createPrefetcher(client: SecClient): Prefetcher {
  const low = client.lowPriority();
  const queue: { filing: FilingRef; company: Company }[] = [];
  const queued = new Set<string>();
  let running = false;
  let current: string | null = null;
  const stats = { done: 0, failed: 0 };

  function neighbours(company: Company, filing: FilingRef): FilingRef[] {
    const list = company.filings;
    const i = list.findIndex((f) => f.accession === filing.accession);
    if (i < 0) return [];
    const out: FilingRef[] = [];
    const push = (f: FilingRef | undefined) => f && !out.includes(f) && f.accession !== filing.accession && out.push(f);
    push(list[i + 1]); // previous filing in time (list is newest first)
    push(list[i - 1]); // next
    push(list.find((f) => f.fiscalYear === filing.fiscalYear! - 1 && f.fiscalPeriod === filing.fiscalPeriod));
    push(list.find((f) => f.fiscalYear === filing.fiscalYear! + 1 && f.fiscalPeriod === filing.fiscalPeriod));
    for (const f of list) if (f.fiscalYear === filing.fiscalYear) push(f);
    push(list[i + 2]);
    push(list[i - 2]);
    return out;
  }

  function schedule(company: Company, filing: FilingRef): void {
    if (!filing?.accession) return;
    for (const f of neighbours(company, filing)) {
      if (queued.has(f.accession) || isCached(f.accession) || store.hasFiling(f.accession)) continue;
      queue.push({ filing: f, company });
      queued.add(f.accession);
    }
    while (queue.length > QUEUE_CAP) queued.delete(queue.shift()!.filing.accession);
    run();
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        while (!client.idle) await new Promise<void>((r) => setTimeout(r, 1000));
        const job = queue.shift()!;
        queued.delete(job.filing.accession);
        if (isCached(job.filing.accession) || store.hasFiling(job.filing.accession)) continue;
        current = job.filing.accession;
        try {
          await scrapeFiling(low, job.filing as ScrapableFiling, job.company);
          stats.done++;
        } catch (err) {
          stats.failed++;
          console.warn(`prefetch ${job.filing.accession} failed: ${(err as Error).message}`);
        }
        current = null;
      }
    } finally {
      running = false;
    }
  }

  return {
    schedule,
    status: () => ({ queued: queue.length, current, ...stats }),
  };
}
