import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { highestTag, nextTag, ensureTag, purgeUntilLive, purgeRequest, changedFiles, verifiedBase, blobSha256, cdnPath, sha256, fullTreeChanges, mapLimit, recordVerified } from './publish-latest.mjs';

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

test('changedFiles returns byte-exact non-ASCII paths and type changes, and leaves out .github', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-files-'));
    // Force git's default path quoting, whatever the machine's config says.
    const run = (...args) => execFileSync('git', ['-C', dir, '-c', 'core.quotePath=true', ...args], { encoding: 'utf8' });
    const commit = (msg) => { run('add', '-A'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return run('rev-parse', 'HEAD').trim(); };
    try {
        run('init', '-q');
        mkdirSync(join(dir, '.github'));
        writeFileSync(join(dir, '.github', 'w.yml'), '1');
        writeFileSync(join(dir, 'a.js'), '1');
        writeFileSync(join(dir, 'b.js'), '1');
        writeFileSync(join(dir, 'naïve.js'), '1');
        const c1 = commit('c1');
        mkdirSync(join(dir, 'dir'));
        writeFileSync(join(dir, 'dir', 'ünï cödé.js'), '2');
        writeFileSync(join(dir, 'naïve.js'), '2');
        writeFileSync(join(dir, '.github', 'w.yml'), '2');
        unlinkSync(join(dir, 'a.js'));
        run('add', '-A');
        // b.js becomes a symlink (mode 120000) without touching the file system: a type change, T.
        const target = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'naïve.js', encoding: 'utf8' }).trim();
        run('update-index', '--cacheinfo', `120000,${target},b.js`);
        run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c2');
        const c2 = run('rev-parse', 'HEAD').trim();

        assert.deepStrictEqual(changedFiles(run, c1, c2),
            [['D', 'a.js'], ['T', 'b.js'], ['A', 'dir/ünï cödé.js'], ['M', 'naïve.js']]);
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

test('blobSha256 hashes committed assets larger than the 1 MiB exec buffer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blob-sha-'));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    try {
        const big = Buffer.alloc(3 * 1024 * 1024, 'x');
        run('init', '-q');
        writeFileSync(join(dir, 'big.js'), big);
        run('add', '-A');
        run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'big');

        assert.strictEqual(blobSha256('HEAD', 'big.js', dir), sha256(big));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('cdnPath percent-encodes each segment and keeps the slashes', () => {
    assert.strictEqual(cdnPath('app/scripts/a#b?c d%.js'), 'app/scripts/a%23b%3Fc%20d%25.js');
    assert.strictEqual(cdnPath('dir/ünï.js'), 'dir/%C3%BCn%C3%AF.js');
    assert.strictEqual(cdnPath('conditionalproductoptions/scripts/0.1.4/conditionalproductoptions.js'),
        'conditionalproductoptions/scripts/0.1.4/conditionalproductoptions.js');
});

test('fullTreeChanges lists every file of head and marks paths earlier tags published as deleted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'full-tree-'));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    const commit = (msg, tag) => {
        run('add', '-A');
        run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
        if (tag) run('-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', tag, '-m', tag);
    };
    try {
        run('init', '-q');
        mkdirSync(join(dir, '.github'));
        writeFileSync(join(dir, '.github', 'w.yml'), '1');
        writeFileSync(join(dir, 'a.js'), '1');
        writeFileSync(join(dir, 'b.js'), '1');
        writeFileSync(join(dir, 'keep.js'), '1');
        commit('c1', 'v1.0.0');
        unlinkSync(join(dir, 'a.js'));
        commit('c2', 'v1.0.1');
        unlinkSync(join(dir, 'b.js'));
        unlinkSync(join(dir, '.github', 'w.yml'));
        writeFileSync(join(dir, 'new.js'), '1');
        commit('c3', 'release-x');

        assert.deepStrictEqual(fullTreeChanges(run, 'HEAD', ['v1.0.0', 'v1.0.1', 'release-x']),
            [['A', 'keep.js'], ['A', 'new.js'], ['D', 'a.js'], ['D', 'b.js']]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('mapLimit keeps at most `limit` calls in flight and returns results in order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async n => {
        peak = Math.max(peak, ++inFlight);
        await new Promise(r => setTimeout(r, n));
        inFlight--;
        return n * 10;
    });
    assert.deepStrictEqual(out, [50, 10, 40, 20, 30, 0, 60]);
    assert.strictEqual(peak, 3);
});

test('purgeUntilLive purges concurrently, bounded by `concurrency`', async () => {
    let inFlight = 0;
    let peak = 0;
    const files = Array.from({ length: 20 }, (_, i) => `f${i}.js`);
    const stale = await purgeUntilLive({
        files,
        expected: Object.fromEntries(files.map(f => [f, 'new'])),
        purge: async () => { peak = Math.max(peak, ++inFlight); await new Promise(r => setTimeout(r, 1)); inFlight--; },
        purgeAlias: async () => {},
        fetchHash: async () => 'new',
        sleep: async () => {},
        concurrency: 4,
        log: () => {},
    });
    assert.deepStrictEqual(stale, []);
    assert.strictEqual(peak, 4);
});

test('purgeUntilLive starts no round after the deadline and reports what is still stale', async () => {
    let clock = 0;
    let rounds = 0;
    const stale = await purgeUntilLive({
        files: ['a.js'],
        expected: { 'a.js': 'new' },
        purge: async () => {},
        purgeAlias: async () => { rounds++; },
        fetchHash: async () => 'old',
        sleep: async ms => { clock += ms; },
        rounds: 12,
        waitMs: 60000,
        deadlineMs: 150000,
        now: () => clock,
        log: () => {},
    });
    assert.deepStrictEqual(stale, ['a.js']);
    assert.strictEqual(rounds, 3);
});

test('changedFiles re-verifies paths a later tag served even when the net diff does not show them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'touched-'));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    const commit = (msg, tag) => {
        run('add', '-A');
        run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
        if (tag) run('tag', tag);
        return run('rev-parse', 'HEAD').trim();
    };
    try {
        run('init', '-q');
        writeFileSync(join(dir, 'foo.js'), 'verified');
        writeFileSync(join(dir, 'keep.js'), '1');
        writeFileSync(join(dir, 'untagged.js'), '1');
        const base = commit('verified', 'v1.0.0');
        // A tagged commit whose run failed: foo.js may be cached with these bytes; tmp.js was served.
        writeFileSync(join(dir, 'foo.js'), 'failed run');
        writeFileSync(join(dir, 'tmp.js'), '1');
        commit('failed', 'v1.0.1');
        // An untagged change is never served by @latest, so reverting it needs no re-check.
        writeFileSync(join(dir, 'untagged.js'), '2');
        commit('untagged');
        // The next commit restores foo.js and untagged.js and drops tmp.js: the net diff shows none.
        writeFileSync(join(dir, 'foo.js'), 'verified');
        writeFileSync(join(dir, 'untagged.js'), '1');
        unlinkSync(join(dir, 'tmp.js'));
        writeFileSync(join(dir, 'other.js'), '1');
        const head = commit('restore', 'v1.0.2');

        assert.deepStrictEqual(changedFiles(run, base, head), [['M', 'foo.js'], ['A', 'other.js'], ['D', 'tmp.js']]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('changedFiles includes paths of tags published after base that a force push took off main', () => {
    const dir = mkdtempSync(join(tmpdir(), 'force-push-'));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    const commit = (msg, tag) => {
        run('add', '-A');
        run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
        if (tag) run('tag', tag);
        return run('rev-parse', 'HEAD').trim();
    };
    try {
        run('init', '-q');
        writeFileSync(join(dir, 'keep.js'), '1');
        const base = commit('verified', 'v1.0.0');
        // An older tag on a side line: published before base, so it must not count.
        writeFileSync(join(dir, 'old.js'), '1');
        commit('side', 'v0.9.0');
        run('reset', '-q', '--hard', base);
        // A tagged run that failed after foo.js went out; main was then force-pushed past it.
        writeFileSync(join(dir, 'foo.js'), '1');
        commit('failed', 'v1.0.1');
        run('reset', '-q', '--hard', base);
        writeFileSync(join(dir, 'bar.js'), '1');
        const head = commit('replacement', 'v1.0.2');
        run('tag', 'v-not-semver', 'v1.0.1');

        assert.deepStrictEqual(changedFiles(run, base, head),
            [['A', 'bar.js'], ['D', 'foo.js']]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('changedFiles re-verifies every path an orphan-history tag served differently from head', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orphan-'));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    const commit = (msg, tag) => {
        run('add', '-A');
        run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
        if (tag) run('tag', tag);
        return run('rev-parse', 'HEAD').trim();
    };
    try {
        run('init', '-q');
        writeFileSync(join(dir, 'keep.js'), '1');
        writeFileSync(join(dir, 'foo.js'), '1');
        const base = commit('verified', 'v1.0.0');
        const branch = run('rev-parse', '--abbrev-ref', 'HEAD').trim();
        // A force-pushed orphan history without keep.js and foo.js, tagged and never verified:
        // @latest answered 404 for both while it pointed there.
        run('checkout', '-q', '--orphan', 'orphan');
        run('rm', '-rqf', '.');
        writeFileSync(join(dir, 'other.js'), '1');
        commit('orphan', 'v1.0.1');
        run('checkout', '-q', '-f', branch);
        writeFileSync(join(dir, 'bar.js'), '1');
        const head = commit('restored main', 'v1.0.2');

        assert.deepStrictEqual(changedFiles(run, base, head),
            [['A', 'bar.js'], ['M', 'foo.js'], ['M', 'keep.js'], ['D', 'other.js']]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** recordVerified I/O where the remote gains `racerTag` on another commit before the re-fetch. */
function verifyIo({ racerTag, pushFails } = {}) {
    const remote = { 'v1.0.6': 'head' };
    if (racerTag) remote[racerTag] = 'other';
    let local = { 'v1.0.6': 'head' };
    const pushes = [];
    const logs = [];
    return {
        pushes,
        logs,
        io: {
            head: 'head',
            tag: 'v1.0.6',
            fetchTags: () => { local = { ...remote }; },
            listTags: () => Object.keys(local),
            tagsAt: sha => Object.keys(local).filter(t => local[t] === sha),
            pushRef: () => { if (pushFails) throw new Error('rejected'); pushes.push('head'); },
            log: m => logs.push(m),
        },
    };
}

test('recordVerified moves the ref when the highest tag still points at head', () => {
    const v = verifyIo();
    assert.strictEqual(recordVerified(v.io), true);
    assert.deepStrictEqual(v.pushes, ['head']);
});

test('recordVerified re-reads the tags and leaves the ref when a higher tag appeared during the run', () => {
    const v = verifyIo({ racerTag: 'v1.0.7' });
    assert.strictEqual(recordVerified(v.io), false);
    assert.deepStrictEqual(v.pushes, []);
    assert.match(v.logs.join(' '), /v1\.0\.7 was tagged during this run/);
});

test('recordVerified ignores a newer non-semver tag and reports a failed push without throwing', () => {
    assert.strictEqual(recordVerified(verifyIo({ racerTag: 'release-x' }).io), true);
    const v = verifyIo({ pushFails: true });
    assert.strictEqual(recordVerified(v.io), false);
    assert.match(v.logs.join(' '), /Could not record head as verified: rejected/);
});
