// Make every push to main live on jsDelivr @latest.
//
// Once a GitHub repo has any tag, jsDelivr resolves @latest to the newest semver tag, not the
// default branch, so an untagged push to main never reaches @latest. This tags main's HEAD with the
// next patch version, purges the changed files, and fails unless @latest then serves the committed bytes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REPO = 'tvlgiao/papathemes-cdn';
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@latest/`;
const PURGE = `https://purge.jsdelivr.net/gh/${REPO}@latest`;
/** Ref (not a tag, so jsDelivr ignores it) at the last commit whose changed files were verified live. */
const VERIFIED_REF = 'refs/published/latest';

/** Largest git output held in memory; execFileSync's 1 MiB default is smaller than some assets. */
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;

/** Run git and return trimmed stdout. */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER }).trim();

/** sha256 hex of a string or buffer. */
export const sha256 = data => createHash('sha256').update(data).digest('hex');

/**
 * sha256 of the committed bytes of `path` at `commit`.
 * @param {string} commit
 * @param {string} path
 * @param {string} [cwd] repository directory
 * @returns {string}
 */
export const blobSha256 = (commit, path, cwd = '.') =>
    sha256(execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd, maxBuffer: GIT_MAX_BUFFER }));

/**
 * URL path for a repository path: each segment percent-encoded, so `#`, `?` and `%` in a file name
 * address that file instead of starting a fragment or a query.
 * @param {string} path
 * @returns {string}
 */
export const cdnPath = path => path.split('/').map(encodeURIComponent).join('/');

/**
 * Highest `vX.Y.Z` tag, compared numerically.
 * @param {string[]} tags
 * @returns {string|undefined}
 */
export function highestTag(tags) {
    return tags
        .map(t => ({ t, v: /^v(\d+)\.(\d+)\.(\d+)$/.exec(t) }))
        .filter(({ v }) => v)
        .map(({ t, v }) => ({ t, n: v.slice(1).map(Number) }))
        .sort((a, b) => a.n[0] - b.n[0] || a.n[1] - b.n[1] || a.n[2] - b.n[2])
        .map(({ t }) => t)
        .pop();
}

/**
 * Next patch after the highest `vX.Y.Z` tag; `v1.0.0` when there is none.
 * @param {string[]} tags
 * @returns {string}
 */
export function nextTag(tags) {
    const top = highestTag(tags);
    if (!top) return 'v1.0.0';
    const [major, minor, patch] = top.slice(1).split('.').map(Number);
    return `v${major}.${minor}.${patch + 1}`;
}

/**
 * Make `head` carry the highest `vX.Y.Z` tag, creating the next one unless it already does. Another
 * publisher may tag concurrently, so a rejected push re-reads the remote tags and either reuses the
 * tag now on `head` or tries the next number.
 * @param {{ head: string, fetchTags: () => void, listTags: () => string[], tagsAt: (sha: string) => string[],
 *   createAndPush: (tag: string, sha: string) => void, isCurrent?: () => boolean, log?: Function,
 *   attempts?: number }} io
 * @returns {string|null} the tag on `head`, or null when `head` stopped being the branch tip
 */
export function ensureTag({ head, fetchTags, listTags, tagsAt, createAndPush, isCurrent = () => true, log = console.log, attempts = 5 }) {
    // Only the highest version moves @latest; a non-semver or older tag on head would leave it behind.
    const reusable = () => {
        fetchTags();
        const top = highestTag(listTags());
        return tagsAt(head).find(t => t === top);
    };
    for (let i = 1; i <= attempts; i++) {
        const existing = reusable();
        if (existing) return existing;
        // A newer commit may have reached main (and a newer tag) since the run started.
        if (!isCurrent()) {
            log(`${head.slice(0, 7)} is no longer the tip of main; not tagging it.`);
            return null;
        }
        const tag = nextTag(listTags());
        try {
            createAndPush(tag, head);
            log(`Tagged ${head.slice(0, 7)} as ${tag}.`);
            return tag;
        } catch (err) {
            log(`Tag ${tag} rejected (${firstLine(err)}), retrying.`);
        }
    }
    // The last rejection may have come from another publisher tagging this same head.
    const existing = reusable();
    if (existing) return existing;
    throw new Error(`Could not tag ${head} after ${attempts} attempts`);
}

/**
 * Files changed from `base` to `head` as [status, path] pairs (A, M, T or D) with byte-exact
 * paths; `.github/` is left out. T (a file turned into a symlink or back) is served differently,
 * so it is published like M.
 * @param {(...args: string[]) => string} run git runner returning raw stdout
 * @param {string} base
 * @param {string} head
 * @returns {Array<[string, string]>}
 */
export function changedFiles(run, base, head) {
    // -z: without it git prints a non-ASCII path quoted and escaped, which `git show` cannot find.
    const fields = run('diff', '--name-status', '--no-renames', '--diff-filter=AMDT', '-z', base, head).split('\0');
    const pairs = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
        if (fields[i + 1]) pairs.push([fields[i], fields[i + 1]]);
    }
    return pairs.filter(([, f]) => !f.startsWith('.github/'));
}

/**
 * Changes to publish when no verified base exists: every file of `head` as A, plus D for each path
 * an earlier `vX.Y.Z` tag published that `head` no longer has, since that deletion cannot be diffed.
 * @param {(...args: string[]) => string} run git runner returning raw stdout
 * @param {string} head
 * @param {string[]} tags
 * @returns {Array<[string, string]>}
 */
export function fullTreeChanges(run, head, tags) {
    const tree = ref => run('ls-tree', '-r', '--name-only', '-z', ref).split('\0').filter(Boolean);
    const current = new Set(tree(head));
    const deleted = new Set();
    for (const tag of tags.filter(t => /^v\d+\.\d+\.\d+$/.test(t))) {
        for (const f of tree(tag)) if (!current.has(f)) deleted.add(f);
    }
    return [...[...current].map(f => ['A', f]), ...[...deleted].sort().map(f => ['D', f])]
        .filter(([, f]) => !f.startsWith('.github/'));
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>} results in the order of `items`
 */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * The last commit whose changed files were verified live, or undefined when that ref does not exist.
 * No tag is a safe fallback: a failed run leaves its tag behind, and diffing from it would skip files
 * that never went live.
 * @param {(...args: string[]) => string} run git runner returning raw stdout
 * @returns {string|undefined}
 */
export function verifiedBase(run) {
    try {
        run('fetch', 'origin', `+${VERIFIED_REF}:${VERIFIED_REF}`);
        return run('rev-parse', VERIFIED_REF).trim();
    } catch {
        return undefined;
    }
}

/** First line of an error's message, for logs. */
const firstLine = err => String((err && err.message) || err).split('\n')[0];

/** Result of a request that failed; never equal to an expected hash or to "not served" (null). */
const FAILED = Symbol('failed');

/** Await `fn`, logging instead of throwing: one flaky request must not end the run. */
async function attempt(fn, what, log) {
    try {
        return await fn();
    } catch (err) {
        log(`${what} failed: ${firstLine(err)}`);
        return FAILED;
    }
}

/**
 * Ask jsDelivr to purge `url`. Resolves only when every provider purged it: fetch() fulfills on an
 * HTTP error, and a throttled purge answers 200.
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<void>}
 * @throws {Error} on a non-2xx status, a throttled path or a provider that did not purge
 */
export async function purgeRequest(url, fetchImpl = fetch) {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json().catch(() => null);
    const paths = Object.values((body && body.paths) || {});
    if (!paths.length) throw new Error('purge answered without a path result');
    if (paths.some(p => p.throttled)) throw new Error('purge throttled');
    if (paths.some(p => Object.values(p.providers || {}).some(ok => !ok))) throw new Error('a provider did not purge');
}

/**
 * Purge `files` on @latest until each serves `expected[file]` (a sha256, or null for a deleted file
 * that must answer 404), re-purging each round: jsDelivr can keep resolving @latest to the previous
 * tag for a few minutes after a new one. A file counts as live only in a round where its purge and
 * the alias purge went through: one edge serving the new bytes says nothing about the other caches.
 * Requests run `concurrency` at a time and no round starts after `deadlineMs`, so a stalled purge
 * endpoint ends the run with the stale list instead of the job timeout killing it; the workflow's
 * timeout-minutes covers the deadline plus one worst-case round.
 * @param {{ files: string[], expected: Object.<string, string|null>, purge: (file: string) => Promise<void>,
 *   purgeAlias: () => Promise<void>, fetchHash: (file: string) => Promise<string|null>,
 *   sleep: (ms: number) => Promise<void>, rounds?: number, waitMs?: number, concurrency?: number,
 *   deadlineMs?: number, now?: () => number, log?: Function }} io
 * @returns {Promise<string[]>} files still not serving the committed state (empty on success)
 */
export async function purgeUntilLive({ files, expected, purge, purgeAlias, fetchHash, sleep, rounds = 12, waitMs = 30000,
    concurrency = 8, deadlineMs = 15 * 60 * 1000, now = Date.now, log = console.log }) {
    const start = now();
    let pending = [...files];
    for (let round = 1; round <= rounds && pending.length; round++) {
        if (now() - start > deadlineMs) {
            log(`Stopping before round ${round}: past the ${Math.round(deadlineMs / 60000)}-minute deadline.`);
            break;
        }
        const aliasPurged = (await attempt(purgeAlias, 'purge @latest alias', log)) !== FAILED;
        const purges = await mapLimit(pending, concurrency, file => attempt(() => purge(file), `purge ${file}`, log));
        await sleep(waitMs);
        const live = await mapLimit(pending.map((file, i) => [file, aliasPurged && purges[i] !== FAILED]), concurrency,
            async ([file, purged]) => purged && (await attempt(() => fetchHash(file), `fetch ${file}`, log)) === expected[file]);
        const stale = pending.filter((file, i) => !live[i]);
        log(`Round ${round}: ${pending.length - stale.length}/${pending.length} live on @latest.`);
        pending = stale;
    }
    return pending;
}

async function main() {
    git('fetch', 'origin', 'main');
    const head = git('rev-parse', 'HEAD');
    // A run from any other checkout (a feature branch, a stale clone) would publish that commit as @latest.
    try {
        git('merge-base', '--is-ancestor', head, 'origin/main');
    } catch {
        throw new Error(`HEAD ${head.slice(0, 7)} is not on origin/main; refusing to tag it.`);
    }
    // Queued runs are not FIFO: tagging an older commit after a newer one would move @latest back.
    // The newer commit contains this one and is published by its own run.
    if (head !== git('rev-parse', 'origin/main')) {
        console.log(`HEAD ${head.slice(0, 7)} is behind origin/main; the newer commit's run publishes it. Skipping.`);
        return;
    }
    git('config', 'user.name', 'papathemes-cdn publish');
    git('config', 'user.email', 'deploy@papathemes.com');
    const listTags = () => git('tag', '-l', 'v*').split('\n').filter(Boolean);
    const tagsAt = sha => git('tag', '--points-at', sha).split('\n').filter(Boolean);

    const tag = ensureTag({
        head,
        fetchTags: () => git('fetch', '--tags', '--force', 'origin'),
        listTags,
        tagsAt,
        isCurrent: () => {
            git('fetch', 'origin', 'main');
            return git('rev-parse', 'origin/main') === head;
        },
        createAndPush: (name, sha) => {
            git('tag', '-a', name, sha, '-m', `publish ${sha.slice(0, 7)}`);
            try {
                git('push', 'origin', `refs/tags/${name}`);
            } catch (err) {
                try {
                    git('tag', '-d', name);
                } catch (cleanup) {
                    console.warn(`Could not delete local tag ${name}: ${firstLine(cleanup)}`);
                }
                throw err;
            }
        },
    });

    if (!tag) return;

    const run = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
    const base = verifiedBase(run);
    if (!base) console.log(`${VERIFIED_REF} is missing; verifying every file.`);
    const changes = base ? changedFiles(run, base, head) : fullTreeChanges(run, head, listTags());
    const files = changes.map(([, f]) => f);
    console.log(`${tag}: ${files.length} changed files since ${base ? base.slice(0, 12) : 'the first commit'}.`);
    const markVerified = () => {
        try {
            git('push', '--force', 'origin', `${head}:${VERIFIED_REF}`);
        } catch (err) {
            console.warn(`Could not record ${head.slice(0, 7)} as verified: ${firstLine(err)}`);
        }
    };
    if (!files.length) {
        markVerified();
        return;
    }

    const expected = Object.fromEntries(changes.map(([status, f]) =>
        [f, status === 'D' ? null : blobSha256(head, f)]));
    const timeout = () => AbortSignal.timeout(20000);
    const stale = await purgeUntilLive({
        files,
        expected,
        purge: f => purgeRequest(`${PURGE}/${cdnPath(f)}`),
        purgeAlias: () => purgeRequest(PURGE),
        fetchHash: async f => {
            const resp = await fetch(CDN + cdnPath(f), { cache: 'no-store', signal: timeout() });
            if (resp.ok) return sha256(Buffer.from(await resp.arrayBuffer()));
            if (resp.status === 404) return null;
            throw new Error(`HTTP ${resp.status}`);
        },
        sleep: ms => new Promise(r => setTimeout(r, ms)),
    });
    if (stale.length) {
        throw new Error(`@latest still serves old bytes for ${stale.length} files:\n${stale.join('\n')}`);
    }
    markVerified();
    console.log(`@latest serves ${tag} for all ${files.length} changed files.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
