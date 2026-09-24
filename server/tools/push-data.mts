// Push the local store up to the data ref (refs/data/main), so what the
// background crawler dug up here reaches the published site.
//
//   npm run data:push                 # push what has changed, as one more commit
//   npm run data:push -- --dry-run    # say what would go, push nothing
//   npm run data:push -- --squash     # replace the ref with a single commit (force push)
//   npm run data:push -- --years 5    # only push the filings of the last 5 years
//   npm run data:push -- --trim       # also drop filings the ref has from before --years
//
// The pair of scripts/pull-data.sh: that one brings the ref down into the
// working tree, this one takes the working tree back up. Neither touches
// `main` or any branch - the commit is built with plumbing (a temporary
// index, write-tree, commit-tree) straight on top of the ref's tip, so the
// working tree, HEAD and the real index are left exactly as they are.
//
// Every filing goes up: a filing file is written once and never touched
// again, so all the commits share the one blob and the history costs
// nothing for them (--years is there for whoever wants a smaller ref).
//
// --squash replaces the ref with a single parentless commit, which is the
// only way to drop what the churny files (company records, ticker table,
// universe) have piled up in the history. It costs a full re-upload: with
// no shared ancestry git cannot tell which objects the server already has,
// so the whole tree goes over the wire again (the server keeps one copy -
// it is bandwidth, not storage). The estimate is printed before it starts.
//
// The Pages workflow pushes to the same ref, so a normal push must
// fast-forward, and a squash must not land on top of a commit it has not
// seen (it would discard it) - both are checked.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name: string, dflt: string | number | null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : dflt;
};
const DRY = args.includes('--dry-run');
const REMOTE = String(opt('--remote', 'origin'));
const REF = String(opt('--ref', 'refs/data/main'));

const { openStore, store } = await import('../lib/store.ts');
const { PUBLISH_YEARS, inWindow, publishFrom } = await import('../lib/publish.ts');
const SQUASH = args.includes('--squash');
const YEARS = Number(opt('--years', PUBLISH_YEARS)) || null; // null = every filing travels
const FROM = publishFrom(YEARS);

const git = (cmdArgs: string[], { input, index }: { input?: string; index?: string } = {}) =>
  execFileSync('git', cmdArgs, {
    cwd: REPO,
    input,
    maxBuffer: 1 << 30,
    env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
  })
    .toString()
    .trim();
const n = (x: number) => x.toLocaleString('en-US');

openStore();

// ---- 1. the tip of the data ref ----
console.log(`push-data: fetching ${REF} from ${REMOTE} (tip only) …`);
try {
  git(['fetch', '--depth=1', '--no-tags', REMOTE, REF]);
} catch (err) {
  console.error(`push-data: cannot fetch ${REF} from ${REMOTE}: ${String((err as { stderr?: string }).stderr || (err as Error).message).trim()}`);
  process.exit(1);
}
const parent = git(['rev-parse', 'FETCH_HEAD']);
console.log(`push-data: ${REF} is at ${parent.slice(0, 9)} (${git(['log', '-1', '--format=%ad %s', '--date=short', parent])})`);

// ---- 2. a temporary index that starts as that commit ----
const index = path.join(REPO, '.git', `data-index-${process.pid}`);
process.on('exit', () => fs.rmSync(index, { force: true }));
const withIndex = (cmdArgs: string[], input?: string) => git(cmdArgs, { input, index });
withIndex(['read-tree', parent]);

// ---- 3. stage the store and the bars ----
// scores, company records, ticker table, documentation: small, all of them
console.log('push-data: staging scores, company records …');
const whole = ['data/store/scores', 'data/store/companies', 'data/store/kv', 'data/store/documentation.json', 'data/store/tickers.json', 'data/store/universe.json'].filter((p) => fs.existsSync(path.join(REPO, p)));
withIndex(['add', '-f', '-A', '--', ...whole]);

// filings: only the window, and only those listed - a filing outside it is
// never hashed, let alone sent
const keep: string[] = [];
let older = 0;
for (const f of store.allFilings()) {
  if (inWindow(f, FROM)) keep.push(`data/store/${f.file}`);
  else older++;
}
console.log(`push-data: staging ${n(keep.length)} filings${FROM ? ` from ${FROM} (${n(older)} older ones stay here)` : ' (everything the store has)'} …`);
if (!keep.length) {
  console.error(`push-data: the store at ${store.file} has no filings in the window - wrong STOCKSCAN_STORE, or nothing crawled yet?`);
  process.exit(1);
}
withIndex(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul', '--'], keep.join('\0'));

// --trim: also drop what the ref still carries from outside the window
// (filings that have aged out of it). Off by default: their blobs are in
// the ref's history for ever either way, so removing them shrinks nothing -
// it only takes them away from `npm run data:pull` and from the site. The
// window's real job is to keep the old ones from ever going up.
if (args.includes('--trim') && FROM) {
  const inIndex = withIndex(['ls-files', '-z', '--', 'data/store/filings']).split('\0').filter(Boolean);
  const drop = inIndex.filter((p) => !inWindow({ file: p }, FROM));
  if (drop.length) {
    console.log(`push-data: --trim: dropping ${n(drop.length)} filings the ref still had from before ${FROM}`);
    withIndex(['update-index', '--force-remove', '-z', '--stdin'], `${drop.join('\0')}\0`);
  }
}

// the daily bars, minus this year's head.zst (it changes every day and the
// workflow fetches its own)
if (fs.existsSync(path.join(REPO, 'data/bars'))) {
  console.log('push-data: staging bars …');
  withIndex(['add', '-f', '-A', '--', 'data/bars', ':(exclude)data/bars/**/head.zst']);
}

// ---- 4. the commit ----
const tree = withIndex(['write-tree']);
if (tree === git(['rev-parse', `${parent}^{tree}`])) {
  console.log('push-data: nothing changed - the ref already has this');
  process.exit(0);
}
const status = git(['diff-tree', '-r', '--name-status', parent, tree]).split('\n').filter(Boolean);
const count: Record<string, number> = { A: 0, M: 0, D: 0 };
for (const line of status) count[line[0]!] = (count[line[0]!] || 0) + 1;
const message = SQUASH
  ? `data: 全部重整成一個 commit（財報 ${n(keep.length)} 份${FROM ? `，${FROM} 起` : ''}）`
  : `data: 本機爬蟲補的財報（新增 ${n(count.A)}、更新 ${n(count.M)}、移除 ${n(count.D)}${FROM ? `；財報保留 ${FROM} 起` : ''}）`;
console.log(`push-data: ${message}`);
const commit = SQUASH ? git(['commit-tree', tree, '-m', message]) : git(['commit-tree', tree, '-p', parent, '-m', message]);
// what actually goes over the wire: everything the new commit reaches that
// the ref's tip does not. A squash shares no history, so that is all of it.
const upload = Number(git(['rev-list', '--disk-usage', '--objects', commit, `^${parent}`]) || 0);
console.log(`push-data: ${(upload / 1048576).toFixed(1)} MB to upload${SQUASH ? ' (a squash re-sends the whole tree - the server already has it, this is bandwidth only)' : ''}`);
if (DRY) {
  console.log('push-data: --dry-run, nothing pushed. A sample of what would change:');
  for (const line of status.slice(0, 10)) console.log(`  ${line}`);
  if (status.length > 10) console.log(`  … ${n(status.length - 10)} more`);
  process.exit(0);
}
if (SQUASH) {
  // a force push replaces whatever is there: make sure nothing landed on
  // the ref while this was building its tree (the workflow pushes here too)
  git(['fetch', '--depth=1', '--no-tags', REMOTE, REF]);
  const now = git(['rev-parse', 'FETCH_HEAD']);
  if (now !== parent) {
    console.error(`push-data: ${REF} moved while this ran (${parent.slice(0, 9)} -> ${now.slice(0, 9)}) - a squash would throw that commit away.`);
    console.error('push-data: run `npm run data:pull` to take it in, then run this again.');
    process.exit(1);
  }
}
try {
  git(['push', ...(SQUASH ? ['--force'] : []), REMOTE, `${commit}:${REF}`]);
} catch (err) {
  const text = String((err as { stderr?: string }).stderr || (err as Error).message).trim();
  console.error(`push-data: push failed: ${text}`);
  if (/non-fast-forward|fetch first|rejected/i.test(text)) console.error(`push-data: ${REF} moved while this ran (the Pages workflow pushes to it too) - just run this again.`);
  process.exit(1);
}
console.log(`push-data: pushed ${commit.slice(0, 9)} to ${REF}${SQUASH ? ' (the ref is one commit now; GitHub reclaims the old objects at its own next gc)' : ''}. The next scheduled Pages build publishes it (pushing this ref does not trigger one).`);
