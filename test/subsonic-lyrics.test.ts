import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const source = fs.readFileSync(path.resolve('src/server/integrations/subsonic.ts'), 'utf8')

function sliceMethod(signature: string) {
  const start = source.indexOf(signature)
  assert.ok(start > 0, `Could not find ${signature}`)
  const rest = source.slice(start + 1)
  const next = rest.search(/\n    (?:private|public|protected) /)
  return next > 0 ? source.slice(start, start + 1 + next) : source.slice(start)
}

function buildLyricHarness(opts: {
  onlineSongs?: Record<string, any>
  listData?: { loveList: any[], defaultList: any[], userList: any[] }
  getLyricImpl?: (source: string, songInfo: any) => Promise<{ lyric: string, tlyric?: string }>
} = {}) {
  const fieldsStart = source.indexOf('    // 在线歌词内存缓存')
  const fieldsEnd = source.indexOf('    // 固定同一关键词的在线结果顺序', fieldsStart)
  assert.ok(fieldsStart > 0 && fieldsEnd > fieldsStart)

  const classBody = [
    fieldsStart >= 0 ? source.slice(fieldsStart, fieldsEnd) : '',
    sliceMethod('    private async handleGetLyrics('),
    sliceMethod('    private buildMergedLrc('),
    sliceMethod('    private async handleGetLyricsBySongId('),
    sliceMethod('    private parseLrc('),
  ].join('\n')

  let findMusicCalls = 0
  let listDataCalls = 0
  let sdkCalls: Array<{ source: string, songInfo: any }> = []
  let responses: any[] = []
  let errors: Array<{ code: number, message: string }> = []

  const onlineSongCache = new Map<string, any>(Object.entries(opts.onlineSongs || {}))

  const musicSdk = new Proxy({}, {
    get(_target, src: string) {
      return {
        getLyric(songInfo: any) {
          sdkCalls.push({ source: src, songInfo })
          const promise = opts.getLyricImpl
            ? opts.getLyricImpl(src, songInfo)
            : Promise.resolve({ lyric: '[00:01.00]test line', tlyric: '' })
          return { promise, cancelHttp: () => {} }
        },
        musicSearch: {
          search: async () => ({ list: [] }),
        },
      }
    },
  })

  const context = vm.createContext({
    URLSearchParams,
    Map,
    Set,
    Promise,
    Date,
    isLocalSong: (id: string) => id.startsWith('local_'),
    lookupLocalLyrics: () => ({ exists: false }),
    musicSdk,
    subsonicLog: { error: () => {} },
    global: { lx: { config: { 'subsonic.lyricTranslation': true } } },
  })

  const compiled = transformSync(`class SubsonicHandler {\n${classBody}\n}; SubsonicHandler`, { loader: 'ts' }).code
  const HandlerClass = vm.runInContext(compiled, context)
  const handler = new HandlerClass()

  handler.onlineSongCache = onlineSongCache
  handler.loadOnlineSongCache = () => {}
  handler.findMusicById = async () => {
    findMusicCalls++
    return null
  }
  handler.getSubsonicListData = async () => {
    listDataCalls++
    return opts.listData || { loveList: [], defaultList: [], userList: [] }
  }
  handler.sendResponse = (_res: any, body: any) => {
    responses.push(body)
  }
  handler.sendError = (_res: any, code: number, message: string) => {
    errors.push({ code, message })
  }

  return {
    handler,
    get findMusicCalls() { return findMusicCalls },
    get listDataCalls() { return listDataCalls },
    get sdkCalls() { return sdkCalls },
    get responses() { return responses },
    get errors() { return errors },
  }
}

test('passes songId from onlineSongCache without invoking findMusicById, deduplicates in-flight calls, and hits lyric cache', async () => {
  let resolveFetch!: (val: { lyric: string, tlyric?: string }) => void
  let callNum = 0
  const harness = buildLyricHarness({
    onlineSongs: {
      tx_003xIl0w0kepGm: {
        id: 'tx_003xIl0w0kepGm',
        source: 'tx',
        songmid: '003xIl0w0kepGm',
        songId: 737241440,
        name: '心湖',
        singer: '张靓颖',
      },
    },
    getLyricImpl: () => {
      callNum++
      return new Promise((resolve) => { resolveFetch = resolve })
    },
  })

  const p1 = harness.handler.handleGetLyricsBySongId({}, 'perly', new URLSearchParams({ id: 'tx_003xIl0w0kepGm' }), 'json')
  const p2 = harness.handler.handleGetLyricsBySongId({}, 'perly', new URLSearchParams({ id: 'tx_003xIl0w0kepGm' }), 'json')
  const p3 = harness.handler.handleGetLyricsBySongId({}, 'perly', new URLSearchParams({ id: 'tx_003xIl0w0kepGm' }), 'json')

  await new Promise(r => setTimeout(r, 10))
  assert.equal(callNum, 1)
  resolveFetch({ lyric: '[00:00.00]心湖\n[00:05.00]张靓颖', tlyric: '' })
  await Promise.all([p1, p2, p3])

  assert.equal(harness.findMusicCalls, 0)
  assert.equal(harness.sdkCalls.length, 1)
  assert.equal(harness.sdkCalls[0].songInfo.songId, 737241440)
  assert.equal(harness.responses.length, 3)

  // Fourth call should hit in-memory lyric cache with zero SDK calls
  await harness.handler.handleGetLyricsBySongId({}, 'perly', new URLSearchParams({ id: 'tx_003xIl0w0kepGm' }), 'json')
  assert.equal(harness.sdkCalls.length, 1)
  assert.equal(harness.responses.length, 4)
  assert.match(harness.responses[3].lyrics.value, /心湖/)
})

test('does not cache empty or failed lyric fetches', async () => {
  let attempt = 0
  const harness = buildLyricHarness({
    onlineSongs: {
      wy_123: { id: 'wy_123', source: 'wy', songmid: '123', name: 'Test', singer: 'Singer' },
    },
    getLyricImpl: async () => {
      attempt++
      if (attempt === 1) throw new Error('Request Timeout')
      if (attempt === 2) return { lyric: '' }
      return { lyric: '[00:01.00]Recovered' }
    },
  })

  await harness.handler.handleGetLyricsBySongId({}, 'perly', new URLSearchParams({ id: 'wy_123' }), 'json')
  assert.equal(harness.errors.length, 1)
  assert.equal(attempt, 1)

  await harness.handler.handleGetLyricsBySongId({}, 'perly', new URLSearchParams({ id: 'wy_123' }), 'json')
  assert.equal(attempt, 2)

  await harness.handler.handleGetLyricsBySongId({}, 'perly', new URLSearchParams({ id: 'wy_123' }), 'json')
  assert.equal(attempt, 3)
  assert.match(harness.responses[1].lyrics.value, /Recovered/)

  await harness.handler.handleGetLyricsBySongId({}, 'perly', new URLSearchParams({ id: 'wy_123' }), 'json')
  assert.equal(attempt, 3)
})

test('handleGetLyrics without id falls back to onlineSongCache and ignores empty title', async () => {
  const harness = buildLyricHarness({
    onlineSongs: {
      wy_3455169579: { id: 'wy_3455169579', source: 'wy', songmid: '3455169579', name: '心湖', singer: '张靓颖' },
      tx_003xIl0w0kepGm: { id: 'tx_003xIl0w0kepGm', source: 'tx', songmid: '003xIl0w0kepGm', songId: 737241440, name: '心湖', singer: '张靓颖' },
    },
    getLyricImpl: async (_src, songInfo) => ({ lyric: `[00:01.00]from-${songInfo.songmid}` }),
  })

  // Empty title must not falsely match
  await harness.handler.handleGetLyrics({}, 'perly', new URLSearchParams({ artist: '', title: '' }), 'json')
  assert.equal(harness.sdkCalls.length, 0)
  assert.match(harness.responses[0].lyrics.value, /Lyrics not found/)

  // Artist + title hits onlineSongCache (prefers latest entry)
  await harness.handler.handleGetLyrics({}, 'perly', new URLSearchParams({ artist: '张靓颖', title: '心湖' }), 'json')
  assert.equal(harness.sdkCalls.length, 1)
  assert.equal(harness.sdkCalls[0].source, 'tx')
  assert.equal(harness.sdkCalls[0].songInfo.songId, 737241440)
  assert.match(harness.responses[1].lyrics.value, /from-003xIl0w0kepGm/)
})

test('handleRequest hot-path guard skips listData and ratings preload for lyric endpoints', () => {
  const match = source.match(/if \(!\[([^\]]+)\]\.includes\(method\)\)/)
  assert.ok(match, 'expected hot-path guard in handleRequest')
  assert.match(match[1], /'getLyrics'/)
  assert.match(match[1], /'getLyricsBySongId'/)
})
