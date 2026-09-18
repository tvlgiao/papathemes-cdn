import { test } from 'node:test';
import assert from 'node:assert';
import { highestTag, nextTag, ensureTag, purgeUntilLive } from './publish-latest.mjs';

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

test('purgeUntilLive reports the files that never went live', async () => {
    const { stale } = await runPurge({ files: ['a.js', 'b.js'], liveAfter: { 'a.js': 1, 'b.js': 99 }, rounds: 4 });

    assert.deepStrictEqual(stale, ['b.js']);
});
