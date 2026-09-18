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

/** Run git and return trimmed stdout. */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** sha256 hex of a string or buffer. */
export const sha256 = data => createHash('sha256').update(data).digest('hex');

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
 * Tag `head` unless a tag already points at it. Another publisher may tag concurrently, so a
 * rejected push re-reads the remote tags and either reuses the tag now on `head` or tries the next.
 * @param {{ head: string, fetchTags: () => void, listTags: () => string[], tagsAt: (sha: string) => string[],
 *   createAndPush: (tag: string, sha: string) => void, log?: Function, attempts?: number }} io
 * @returns {string} the tag on `head`
 */
export function ensureTag({ head, fetchTags, listTags, tagsAt, createAndPush, log = console.log, attempts = 5 }) {
    for (let i = 1; i <= attempts; i++) {
        fetchTags();
        const existing = tagsAt(head);
        if (existing.length) return existing[0];
        const tag = nextTag(listTags());
        try {
            createAndPush(tag, head);
            log(`Tagged ${head.slice(0, 7)} as ${tag}.`);
            return tag;
        } catch (err) {
            log(`Tag ${tag} rejected (${firstLine(err)}), retrying.`);
        }
    }
    throw new Error(`Could not tag ${head} after ${attempts} attempts`);
}

/** First line of an error's message, for logs. */
const firstLine = err => String((err && err.message) || err).split('\n')[0];

/** Await `fn`, logging instead of throwing: one flaky request must not end the run. */
async function attempt(fn, what, log) {
    try {
        return await fn();
    } catch (err) {
        log(`${what} failed: ${firstLine(err)}`);
        return null;
    }
}

/**
 * Purge `files` on @latest until each serves `expected[file]`, re-purging each round:
 * jsDelivr can keep resolving @latest to the previous tag for a few minutes after a new one.
 * @param {{ files: string[], expected: Object.<string, string>, purge: (file: string) => Promise<void>,
 *   purgeAlias: () => Promise<void>, fetchHash: (file: string) => Promise<string|null>,
 *   sleep: (ms: number) => Promise<void>, rounds?: number, waitMs?: number, log?: Function }} io
 * @returns {Promise<string[]>} files still not serving the committed bytes (empty on success)
 */
export async function purgeUntilLive({ files, expected, purge, purgeAlias, fetchHash, sleep, rounds = 12, waitMs = 30000, log = console.log }) {
    let pending = [...files];
    for (let round = 1; round <= rounds && pending.length; round++) {
        await attempt(purgeAlias, 'purge @latest alias', log);
        for (const file of pending) await attempt(() => purge(file), `purge ${file}`, log);
        await sleep(waitMs);
        const stale = [];
        for (const file of pending) {
            if ((await attempt(() => fetchHash(file), `fetch ${file}`, log)) !== expected[file]) stale.push(file);
        }
        log(`Round ${round}: ${pending.length - stale.length}/${pending.length} live on @latest.`);
        pending = stale;
    }
    return pending;
}

async function main() {
    git('config', 'user.name', 'papathemes-cdn publish');
    git('config', 'user.email', 'deploy@papathemes.com');
    const head = git('rev-parse', 'HEAD');
    const listTags = () => git('tag', '-l', 'v*').split('\n').filter(Boolean);
    const tagsAt = sha => git('tag', '--points-at', sha).split('\n').filter(Boolean);

    const tag = ensureTag({
        head,
        fetchTags: () => git('fetch', '--tags', '--force', 'origin'),
        listTags,
        tagsAt,
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

    const headTags = tagsAt(head);
    const prev = highestTag(listTags().filter(t => !headTags.includes(t)));
    const files = (prev ? git('diff', '--name-only', '--diff-filter=AM', prev, head) : git('ls-tree', '-r', '--name-only', head))
        .split('\n')
        .filter(f => f && !f.startsWith('.github/'));
    console.log(`${tag}: ${files.length} changed files since ${prev || 'the first commit'}.`);
    if (!files.length) return;

    const expected = Object.fromEntries(files.map(f => [f, sha256(execFileSync('git', ['show', `${head}:${f}`]))]));
    const timeout = () => AbortSignal.timeout(20000);
    const stale = await purgeUntilLive({
        files,
        expected,
        purge: async f => { await fetch(`${PURGE}/${encodeURI(f)}`, { signal: timeout() }); },
        purgeAlias: async () => { await fetch(PURGE, { signal: timeout() }); },
        fetchHash: async f => {
            const resp = await fetch(CDN + encodeURI(f), { cache: 'no-store', signal: timeout() });
            return resp.ok ? sha256(Buffer.from(await resp.arrayBuffer())) : null;
        },
        sleep: ms => new Promise(r => setTimeout(r, ms)),
    });
    if (stale.length) {
        throw new Error(`@latest still serves old bytes for ${stale.length} files:\n${stale.join('\n')}`);
    }
    console.log(`@latest serves ${tag} for all ${files.length} changed files.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
