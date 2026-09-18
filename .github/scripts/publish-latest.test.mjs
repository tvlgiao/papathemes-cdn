import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { highestTag, nextTag, ensureTag, purgeUntilLive, purgeRequest, changedFiles, verifiedBase } from './publish-latest.mjs';

test('highestTag compares numerically and ignores non-semver tags', () => {
    assert.strictEqual(highestTag(['v1.0.9', 'v1.0.10', 'v1.0.2', 'release', 'v2']), 'v1.0.10');
    assert.strictEqual(highestTag([]), undefined);
});

test('nextTag bumps the patch of the highest tag, v1.0.0 when there is none', () => {
    assert.strictEqual(nextTag(['v1.0.4', 'v1.0.10', 'v0.9.99']), 'v1.0.11');
    assert.strictEqual(nextTag(['v2.3.0', 'v1.9.9']), 'v2.3.1');
    assert.strictEqual(nextTag(['latest']), 'v1.0.0');
});

/** Fake remote: `remote` maps tag -> sha; `racer` may add a tag just before a push. */
function fakeRepo(remote, { racer } = {}) {
    let local = {};
    const pushes = [];
    return {
        pushes,
        remote,
        io: head => ({
            head,
            log: () => {},
            fetchTags: () => { local = { ...remote }; },
            listTags: () => Object.keys(local),
            tagsAt: sha => Object.keys(local).filter(t => local[t] === sha),
            createAndPush: (tag, sha) => {
                if (racer) racer(remote);
                pushes.push(tag);
                if (remote[tag]) throw new Error(`! [rejected] ${tag} (already exists)`);
                remote[tag] = sha;
            },
        }),
    };
}

test('ensureTag tags head with the next patch', () => {
    const repo = fakeRepo({ 'v1.0.5': 'aaa' });
    assert.strictEqual(ensureTag(repo.io('bbb')), 'v1.0.6');
    assert.strictEqual(repo.remote['v1.0.6'], 'bbb');
});

test('ensureTag reuses a tag already on head and pushes nothing', () => {
    const repo = fakeRepo({ 'v1.0.5': 'aaa', 'v1.0.6': 'bbb' });
    assert.strictEqual(ensureTag(repo.io('bbb')), 'v1.0.6');
    assert.deepStrictEqual(repo.pushes, []);
});

test('ensureTag reuses the tag another publisher put on head during the race', () => {
    let raced = false;
    const repo = fakeRepo({ 'v1.0.5': 'aaa' }, {
        racer: remote => { if (!raced) { raced = true; remote['v1.0.6'] = 'bbb'; } },
    });
    assert.strictEqual(ensureTag(repo.io('bbb')), 'v1.0.6');
    assert.deepStrictEqual(repo.pushes, ['v1.0.6']);
});

test('ensureTag moves to the next number when a racer took the name for another commit', () => {
    let raced = false;
    const repo = fakeRepo({ 'v1.0.5': 'aaa' }, {
        racer: remote => { if (!raced) { raced = true; remote['v1.0.6'] = 'zzz'; } },
    });
    assert.strictEqual(ensureTag(repo.io('bbb')), 'v1.0.7');
    assert.strictEqual(repo.remote['v1.0.7'], 'bbb');
    assert.strictEqual(repo.remote['v1.0.6'], 'zzz');
});

test('ensureTag does not reuse a non-semver tag on head: it would not move @latest', () => {
    const repo = fakeRepo({ 'v1.0.5': 'aaa', 'release-x': 'bbb' });
    assert.strictEqual(ensureTag(repo.io('bbb')), 'v1.0.6');
    assert.strictEqual(repo.remote['v1.0.6'], 'bbb');
});

test('ensureTag does not reuse an older semver tag on head while a higher one exists', () => {
    const repo = fakeRepo({ 'v1.0.3': 'bbb', 'v1.0.9': 'aaa' });
    assert.strictEqual(ensureTag(repo.io('bbb')), 'v1.0.10');
});

test('ensureTag succeeds when the last rejected push lost to a tag on this same head', () => {
    let pushes = 0;
    const repo = fakeRepo({ 'v1.0.5': 'aaa' }, {
        racer: remote => { pushes++; remote[`v1.0.${5 + pushes}`] = pushes === 3 ? 'bbb' : 'zzz'; },
    });
    assert.strictEqual(ensureTag({ ...repo.io('bbb'), attempts: 3 }), 'v1.0.8');
});

test('ensureTag does not tag a head that main moved past during the run', () => {
    const repo = fakeRepo({ 'v1.0.5': 'aaa', 'v1.0.6': 'ccc' });
    assert.strictEqual(ensureTag({ ...repo.io('bbb'), isCurrent: () => false }), null);
    assert.deepStrictEqual(repo.pushes, []);
});

test('ensureTag stops retrying once main has moved on', () => {
    let current = true;
    const repo = fakeRepo({ 'v1.0.5': 'aaa' }, {
        racer: remote => { remote['v1.0.6'] = 'zzz'; current = false; },
    });
    assert.strictEqual(ensureTag({ ...repo.io('bbb'), isCurrent: () => current }), null);
    assert.deepStrictEqual(repo.pushes, ['v1.0.6']);
});

test('ensureTag gives up after the attempts are used', () => {
    const repo = fakeRepo({}, { racer: remote => { remote[`v1.0.${Object.keys(remote).length}`] = 'other'; } });
    assert.throws(() => ensureTag({ ...repo.io('bbb'), attempts: 3 }), /Could not tag bbb after 3 attempts/);
});

/** purgeUntilLive with a CDN that turns live after `liveAfter` purges of a file. */
async function runPurge({ files, liveAfter, rounds = 5 }) {
    const purges = {};
    let aliasPurges = 0;
    const stale = await purgeUntilLive({
        files,
        expected: Object.fromEntries(files.map(f => [f, `new:${f}`])),
        purge: async f => { purges[f] = (purges[f] || 0) + 1; },
        purgeAlias: async () => { aliasPurges++; },
        fetchHash: async f => ((purges[f] || 0) >= (liveAfter[f] ?? 1) ? `new:${f}` : `old:${f}`),
        sleep: async () => {},
        rounds,
        log: () => {},
    });
    return { stale, purges, aliasPurges };
}

test('purgeUntilLive re-purges only the files still stale until all are live', async () => {
    const { stale, purges, aliasPurges } = await runPurge({ files: ['a.js', 'b.js'], liveAfter: { 'a.js': 1, 'b.js': 3 } });

    assert.deepStrictEqual(stale, []);
    assert.deepStrictEqual(purges, { 'a.js': 1, 'b.js': 3 });
    assert.strictEqual(aliasPurges, 3);
});

test('purgeUntilLive keeps going through failed purge and fetch requests', async () => {
    let purges = 0;
    let aliasPurges = 0;
    let fetches = 0;
    const stale = await purgeUntilLive({
        files: ['a.js'],
        expected: { 'a.js': 'new' },
        purge: async () => { if (++purges < 2) throw new Error('ECONNRESET'); },
        purgeAlias: async () => { if (++aliasPurges < 3) throw new Error('ETIMEDOUT'); },
        fetchHash: async () => { if (++fetches < 2) throw new Error('socket hang up'); return 'new'; },
        sleep: async () => {},
        rounds: 5,
        log: () => {},
    });

    assert.deepStrictEqual(stale, []);
    assert.strictEqual(aliasPurges, 4);
});

test('purgeUntilLive does not count a file live while its purge fails, even if one edge serves it', async () => {
    const stale = await purgeUntilLive({
        files: ['a.js', 'b.js'],
        expected: { 'a.js': 'new', 'b.js': 'new' },
        purge: async f => { if (f === 'b.js') throw new Error('HTTP 429'); },
        purgeAlias: async () => {},
        fetchHash: async () => 'new',
        sleep: async () => {},
        rounds: 3,
        log: () => {},
    });

    assert.deepStrictEqual(stale, ['b.js']);
});

test('purgeUntilLive does not count any file live while the alias purge fails', async () => {
    const stale = await purgeUntilLive({
        files: ['a.js'],
        expected: { 'a.js': 'new' },
        purge: async () => {},
        purgeAlias: async () => { throw new Error('HTTP 500'); },
        fetchHash: async () => 'new',
        sleep: async () => {},
        rounds: 3,
        log: () => {},
    });

    assert.deepStrictEqual(stale, ['a.js']);
});

/** fetch() stand-in answering one purge request. */
const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const purged = (entry) => ({ id: 'x', status: 'finished', paths: { '/gh/o/r@latest/a.js': entry } });

test('purgeRequest resolves only when every provider purged the path', async () => {
    await purgeRequest('u', answer(200, purged({ throttled: false, providers: { CF: true, FY: true } })));
    await assert.rejects(purgeRequest('u', answer(429, {})), /HTTP 429/);
    await assert.rejects(purgeRequest('u', answer(500, null)), /HTTP 500/);
    await assert.rejects(purgeRequest('u', answer(200, purged({ throttled: true, providers: { CF: true, FY: true } }))), /throttled/);
    await assert.rejects(purgeRequest('u', answer(200, purged({ throttled: false, providers: { CF: true, FY: false } }))), /provider/);
    await assert.rejects(purgeRequest('u', answer(200, { status: 'finished' })), /without a path/);
});

test('changedFiles returns byte-exact non-ASCII paths, leaves out .github, and lists every file without a base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-files-'));
    // Force git's default path quoting, whatever the machine's config says.
    const run = (...args) => execFileSync('git', ['-C', dir, '-c', 'core.quotePath=true', ...args], { encoding: 'utf8' });
    const commit = (msg) => { run('add', '-A'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return run('rev-parse', 'HEAD').trim(); };
    try {
        run('init', '-q');
        mkdirSync(join(dir, '.github'));
        writeFileSync(join(dir, '.github', 'w.yml'), '1');
        writeFileSync(join(dir, 'a.js'), '1');
        writeFileSync(join(dir, 'naïve.js'), '1');
        const c1 = commit('c1');
        mkdirSync(join(dir, 'dir'));
        writeFileSync(join(dir, 'dir', 'ünï cödé.js'), '2');
        writeFileSync(join(dir, 'naïve.js'), '2');
        writeFileSync(join(dir, '.github', 'w.yml'), '2');
        unlinkSync(join(dir, 'a.js'));
        const c2 = commit('c2');

        assert.deepStrictEqual(changedFiles(run, c1, c2), [['D', 'a.js'], ['A', 'dir/ünï cödé.js'], ['M', 'naïve.js']]);
        assert.deepStrictEqual(changedFiles(run, undefined, c1), [['A', 'a.js'], ['A', 'naïve.js']]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('purgeUntilLive accepts a deleted file once it answers 404, not while it still serves', async () => {
    let served = 2;
    const stale = await purgeUntilLive({
        files: ['gone.js'],
        expected: { 'gone.js': null },
        purge: async () => {},
        purgeAlias: async () => {},
        fetchHash: async () => (served-- > 0 ? 'old-bytes' : null),
        sleep: async () => {},
        rounds: 5,
        log: () => {},
    });

    assert.deepStrictEqual(stale, []);
    assert.strictEqual(served, -1);
});

test('purgeUntilLive does not count a failed request as a deleted file being gone', async () => {
    const stale = await purgeUntilLive({
        files: ['gone.js'],
        expected: { 'gone.js': null },
        purge: async () => {},
        purgeAlias: async () => {},
        fetchHash: async () => { throw new Error('HTTP 503'); },
        sleep: async () => {},
        rounds: 3,
        log: () => {},
    });

    assert.deepStrictEqual(stale, ['gone.js']);
});

test('purgeUntilLive reports the files that never went live', async () => {
    const { stale } = await runPurge({ files: ['a.js', 'b.js'], liveAfter: { 'a.js': 1, 'b.js': 99 }, rounds: 4 });

    assert.deepStrictEqual(stale, ['b.js']);
});

test('verifiedBase reads the verified ref and ignores tags when the ref does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verified-base-'));
    const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    try {
        const origin = join(dir, 'origin.git');
        const work = join(dir, 'work');
        git(dir, 'init', '-q', '--bare', origin);
        git(dir, 'init', '-q', work);
        writeFileSync(join(work, 'f'), '1');
        git(work, 'add', 'f');
        git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c1');
        const c1 = git(work, 'rev-parse', 'HEAD').trim();
        git(work, 'remote', 'add', 'origin', origin);
        git(work, 'tag', 'v1.0.0');
        git(work, 'push', '-q', 'origin', 'HEAD:main', 'v1.0.0');
        const run = (...args) => git(work, ...args);

        assert.strictEqual(verifiedBase(run), undefined);
        git(work, 'push', '-q', 'origin', 'HEAD:refs/published/latest');
        assert.strictEqual(verifiedBase(run), c1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
