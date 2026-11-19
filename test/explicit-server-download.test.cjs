const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createDownloadManager(fetchImpl, extraWindow = {}) {
    const source = fs.readFileSync('public/music/js/download/download_manager.js', 'utf8');
    const context = vm.createContext({
        window: {
            settings: { enableOnlyDownloadMode: false, enableServerLyricCache: true, embedLyricToFile: true },
            ensureDownloadSession: async () => {},
            getUserAuthHeaders: () => ({ 'x-user-token': 'test-token' }),
            QualityManager: { getBestQuality: (_song, pref) => pref || 'flac' },
            ...extraWindow,
        },
        fetch: fetchImpl,
        console,
        AbortController,
        URL,
    });
    vm.runInContext(source.slice(0, source.indexOf('// Global UI Toggles')) + '\nthis.Manager = DownloadManager;', context);
    const mgr = Object.create(context.Manager.prototype);
    Object.assign(mgr, {
        tasks: [],
        maxConcurrent: 3,
        activeCount: 0,
        serverQueuePending: false,
        renderTask() {},
        renderList() {},
        saveTasks() {},
        processQueue() {},
        syncServerQueue: async () => {},
        updateBadge() {},
        showQueue: () => {},
    });
    return { mgr, context };
}

test('explicit saveToMusicDir tasks use enableOnlyDownloadMode=true even when enableOnlyDownloadMode setting is false', async () => {
    let queuePayload;
    let downloadPayload;
    const { mgr } = createDownloadManager(async (url, options) => {
        if (url === '/api/music/cache/queue') {
            queuePayload = JSON.parse(options.body);
            return { ok: true, json: async () => ({ success: true, data: {} }) };
        }
        if (url === '/api/music/cache/download') {
            downloadPayload = JSON.parse(options.body);
            return { ok: true, json: async () => ({ success: true }) };
        }
        throw new Error('unexpected fetch: ' + url);
    }, {
        resolveSongUrl: async () => ({ url: 'https://cdn.example/song.flac', quality: 'flac' }),
    });

    await mgr.enqueueServerTasks([
        { id: 'server_1', song: { id: 'wy_1', name: 'A' }, quality: 'flac', saveToMusicDir: true },
        { id: 'server_2', song: { id: 'wy_2', name: 'B' }, quality: 'flac', saveToMusicDir: false },
    ]);
    assert.equal(queuePayload.tasks[0].enableOnlyDownloadMode, true);
    assert.equal(queuePayload.tasks[1].enableOnlyDownloadMode, false);

    const task = { id: 'server_1', isServer: true, saveToMusicDir: true, song: { id: 'wy_1', name: 'A', source: 'wy' }, quality: 'flac', status: 'waiting' };
    await mgr.startServerDownload(task);
    assert.equal(downloadPayload.enableOnlyDownloadMode, true);

    task.status = 'finished';
    assert.equal(mgr.shouldAutoSyncLyric({ ...task, saveToMusicDir: true }), false);
});

test('addTasks keeps saveToMusicDir download when file only exists in cache folder, skips when in music folder', async () => {
    const cacheChecks = new Map([
        ['wy_in_cache', { exists: true, isCollision: false, folder: 'cache' }],
        ['wy_in_music', { exists: true, isCollision: false, folder: 'music' }],
    ]);
    const source = fs.readFileSync('public/music/js/download/download_manager.js', 'utf8');
    const queuedBatches = [];
    const context = vm.createContext({
        window: {
            settings: { enableOnlyDownloadMode: false, preferredQuality: 'flac' },
            ensureDownloadSession: async () => {},
            getUserAuthHeaders: () => ({}),
            QualityManager: { getBestQuality: () => 'flac' },
        },
        checkServerCache: async (song) => cacheChecks.get(song.id) || { exists: false },
        fetch: async () => ({ ok: true, json: async () => ({ success: true, data: {} }) }),
        console,
        AbortController,
        URL,
    });
    vm.runInContext(source.slice(0, source.indexOf('// Global UI Toggles')) + '\nthis.Manager = DownloadManager;', context);
    const mgr = Object.create(context.Manager.prototype);
    Object.assign(mgr, {
        tasks: [],
        maxConcurrent: 3,
        activeCount: 0,
        renderTask() {},
        renderList() {},
        saveTasks() {},
        processQueue() {},
        enqueueServerTasks: async (tasks) => queuedBatches.push(tasks),
    });

    await mgr.addTasks([
        { id: 'wy_in_cache', name: 'Cached', source: 'wy', isServer: true, saveToMusicDir: true, explicitQuality: 'flac' },
        { id: 'wy_in_music', name: 'Downloaded', source: 'wy', isServer: true, saveToMusicDir: true, explicitQuality: 'flac' },
    ]);

    assert.equal(queuedBatches.length, 1);
    assert.equal(queuedBatches[0].length, 1);
    assert.equal(queuedBatches[0][0].song.id, 'wy_in_cache');
    assert.equal(queuedBatches[0][0].saveToMusicDir, true);
});
