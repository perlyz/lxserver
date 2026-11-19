import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { splitSingers } from '../src/modules/dislike/match'
import { toSimplified } from '../src/server/utils/zhConvert'

const source = fs.readFileSync(path.resolve('src/server/integrations/subsonic.ts'), 'utf8')
const parseDurationStart = source.indexOf('    private parseDuration(')
const parseDurationEnd = source.indexOf('    /**\n     * 将 MusicInfo 映射为 Subsonic', parseDurationStart)
assert.ok(parseDurationStart > 0 && parseDurationEnd > parseDurationStart)

const resolveStart = source.indexOf('    private getQualityPriorityOrder(')
const resolveEnd = source.indexOf('    /**\n     * [transcoding] getTranscodeDecision', resolveStart)
assert.ok(resolveStart > 0 && resolveEnd > resolveStart)

const methods = [
  source.slice(parseDurationStart, parseDurationEnd),
  source.slice(resolveStart, resolveEnd),
].join('\n')

function buildHarness(opts: {
  config?: Record<string, any>
  probeResult?: (url: string, timeoutMs?: number) => Promise<'ok' | 'invalid' | 'timeout'>
  callUserApiGetMusicUrl?: (source: string, musicInfo: any, quality: string) => Promise<any>
  musicSdk?: Record<string, any>
} = {}) {
  const config: Record<string, any> = {
    'subsonic.quality.enabled': true,
    'subsonic.quality.priority': '320k,128k',
    'subsonic.source.crossPlatform': true,
    'subsonic.source.priority': 'kw,tx,wy,mg,kg',
    'subsonic.enableDebug': false,
    ...(opts.config || {}),
  }

  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    Promise.resolve(p).then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })

  const context = vm.createContext({
    global: { lx: { config } },
    withTimeout,
    splitSingers,
    toSimplified,
    subsonicLog: { debug() {}, warn() {}, error() {} },
    probeAudioUrl: opts.probeResult || (async () => 'ok'),
    callUserApiGetMusicUrl: opts.callUserApiGetMusicUrl || (async () => null),
    musicSdk: opts.musicSdk || {},
    Date,
    Math,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
  })

  const harnessCode = `
class Harness {
  resolveStreamInFlight = new Map()
${methods}
}
globalThis.Harness = Harness
`
  vm.runInContext(transformSync(harnessCode, { loader: 'ts', format: 'cjs', target: 'node20' }).code, context)
  return new (context as any).Harness()
}

test('原平台直链仅因服务端探测超时(timeout)时直接返回，不跨平台换源或被他源覆盖', async () => {
  let crossSearchCalls = 0
  const apiCalls: Array<{ source: string, quality: string }> = []
  const instance = buildHarness({
    callUserApiGetMusicUrl: async (src, _info, q) => {
      apiCalls.push({ source: src, quality: q })
      if (src === 'tx') return { url: `http://ws.stream.qqmusic.qq.com/${q}.mp3`, type: q }
      if (src === 'kg') return { url: 'https://cdn-img.gitcode.com/fake-7s.mp3', type: '128k' }
      return null
    },
    probeResult: async (url) => (url.includes('qqmusic.qq.com') ? 'timeout' : 'ok'),
    musicSdk: {
      kw: { musicSearch: { search: async () => { crossSearchCalls++; return { list: [] } } } },
      kg: { musicSearch: { search: async () => { crossSearchCalls++; return { list: [{ name: '画心', singer: '张靓颖', interval: '07:12', songmid: 'kg1' }] } } } },
    },
  })

  const res = await instance.resolveStreamUrl(
    'tx',
    '0045cdSn27l6YM',
    'tx_0045cdSn27l6YM',
    { id: 'tx_0045cdSn27l6YM', name: '画心', singer: '张靓颖', interval: '07:12' },
    '320k',
    192,
    'perly',
  )

  assert.equal(res.url, 'http://ws.stream.qqmusic.qq.com/128k.mp3')
  assert.equal(res.quality, '128k')
  assert.equal(crossSearchCalls, 0, '原平台已取到直链且仅探测超时时，不得触发跨平台搜索')
  assert.deepEqual(apiCalls, [{ source: 'tx', quality: '128k' }])
})

test('原平台直链明确失效(invalid)时才跨平台换源，且保留目标平台原生字段', async () => {
  let capturedMgMusic: any = null
  const instance = buildHarness({
    config: { 'subsonic.source.priority': 'mg,kw' },
    callUserApiGetMusicUrl: async (src, info, q) => {
      if (src === 'tx') return { url: 'http://tx.invalid/404.mp3', type: q }
      if (src === 'mg') {
        capturedMgMusic = info
        return { url: 'http://mg.example/good.mp3', type: q }
      }
      return null
    },
    probeResult: async (url) => (url.includes('tx.invalid') ? 'invalid' : 'ok'),
    musicSdk: {
      mg: {
        musicSearch: {
          search: async () => ({
            list: [
              { name: '画心 (伴奏)', singer: '张靓颖', interval: '07:12', songmid: 'mg_inst', copyrightId: 'c_inst' },
              { name: '画心', singer: '张靓颖', interval: '07:12', songmid: 'mg_real', copyrightId: 'c_real' },
            ],
          }),
        },
      },
    },
  })

  const res = await instance.resolveStreamUrl(
    'tx',
    '0045cdSn27l6YM',
    'tx_0045cdSn27l6YM',
    { id: 'tx_0045cdSn27l6YM', name: '画心', singer: '张靓颖', interval: '07:12' },
    '128k',
    192,
    'perly',
  )

  assert.equal(res.url, 'http://mg.example/good.mp3')
  assert.equal(res.selected, 'source:tx->mg/128k')
  assert.equal(capturedMgMusic?.copyrightId, 'c_real')
  assert.equal(capturedMgMusic?.meta?.copyrightId, 'c_real')
})

test('pickBestCrossSourceMatch 严格拦截串歌：拒绝子串误命中、伴奏/Live 错版、时长与歌手不符', () => {
  const instance = buildHarness()

  // 1. 禁止短歌名子串误命中完全不同的歌
  assert.equal(
    instance.matchSongAcrossSources(
      { name: '如果这就是爱情', singer: '张靓颖', interval: '04:42' },
      { name: '爱', singer: '张靓颖', interval: '03:50' },
    ),
    false,
  )
  assert.equal(
    instance.matchSongAcrossSources(
      { name: '十年之后', singer: '陈奕迅', interval: '04:00' },
      { name: '十年', singer: '陈奕迅', interval: '03:25' },
    ),
    false,
  )

  // 2. 拒绝伴奏 / Live 错版，并优先选精确版而非副标题版
  const picked = instance.pickBestCrossSourceMatch(
    [
      { name: '画心 (伴奏)', singer: '张靓颖', interval: '07:12', songmid: 'inst' },
      { name: '画心 (Live)', singer: '张靓颖', interval: '05:03', songmid: 'live' },
      { name: '画心 (电影《画皮》主题曲)', singer: '张靓颖', interval: '07:12', songmid: 'sub' },
      { name: '畫心', singer: '张靓颖', interval: '07:12', songmid: 'exact_trad' },
    ],
    { name: '画心', singer: '张靓颖', interval: '07:12' },
  )
  assert.equal(picked?.songmid, 'exact_trad')

  // 3. 歌手不符或时长差异过大时拒绝
  assert.equal(
    instance.matchSongAcrossSources(
      { name: '画心', singer: '别人', interval: '07:12' },
      { name: '画心', singer: '张靓颖', interval: '07:12' },
    ),
    false,
  )
  assert.equal(
    instance.matchSongAcrossSources(
      { name: '画心', singer: '张靓颖', interval: '02:00' },
      { name: '画心', singer: '张靓颖', interval: '07:12' },
    ),
    false,
  )
})
