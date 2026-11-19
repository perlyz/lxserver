import http from 'http'
import { getProxyAgent } from '../../modules/utils/proxy.js'

/**
 * 封面图片代理与缓存（图片显示核心实现）
 *
 * 崩溃防护（本模块核心目标之一）：
 * - handleGetCoverArt / proxyCoverImage 全链路 try/catch，fetch 异常不会冒泡到事件循环导致 worker 崩溃。
 * - 缓存带容量上限（COVER_CACHE_MAX），避免长期运行 Buffer 堆积引发 OOM 崩溃。
 *
 * - 内存缓存：按图片 URL 缓存抓取到的字节。客户端刷新时会并发重抓几十张 QQ 封面，
 *   若每次都回源易被图片 CDN 限流导致大量 204（封面空白）。缓存后刷新直接命中，规避限流。
 * - 并发信号量：QQ 图片 CDN 对服务端并发抓取限流极严（12 并发约 9 张失败）。
 *   限制同时回源数量，让封面排队抓取，绝大多数能成功；失败再重试。
 * - 失败重试 + 过期降级：降低空白封面概率，回源彻底失败时仍返回过期缓存而非消失。
 */

const coverImageCache = new Map<string, { ts: number, buf: Buffer, ct: string }>()
const COVER_CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const COVER_CACHE_MAX = 3000
const coverFailCache = new Map<string, number>()
const COVER_FAIL_TTL = 30 * 1000
const COVER_FAIL_MAX = 500
const DEFAULT_FETCH_TIMEOUT_MS = 8000
const DEFAULT_RETRY_DELAY_MS = 400
const GLOBAL_MAX_CONCURRENT = 8
const HOST_MAX_CONCURRENT = 2

const inFlightFetches = new Map<string, Promise<{ buf: Buffer, ct: string } | null>>()

function coverCacheSet(key: string, val: { ts: number, buf: Buffer, ct: string }) {
    coverImageCache.set(key, val)
    coverFailCache.delete(key)
    // 容量上限：超出时淘汰最旧条目，避免长期运行 Buffer 堆积导致 OOM 崩溃
    if (coverImageCache.size > COVER_CACHE_MAX) {
        const oldest = coverImageCache.keys().next().value
        if (oldest !== undefined) coverImageCache.delete(oldest)
    }
}

function coverFailSet(key: string, ts: number) {
    coverFailCache.set(key, ts)
    if (coverFailCache.size > COVER_FAIL_MAX) {
        const oldest = coverFailCache.keys().next().value
        if (oldest !== undefined) coverFailCache.delete(oldest)
    }
}

// 并发信号量：按域名独立限流（防单图床 CDN 如 QQ 并发过高被封），同时限制全局总并发
const globalSem = { active: 0, max: GLOBAL_MAX_CONCURRENT, waiters: [] as Array<() => void> }
const hostSems = new Map<string, { active: number, max: number, waiters: Array<() => void> }>()

function semAcquire(sem: { active: number, max: number, waiters: Array<() => void> }): Promise<void> {
    return new Promise<void>((resolve) => {
        if (sem.active < sem.max) {
            sem.active++
            resolve()
        } else {
            sem.waiters.push(resolve)
        }
    })
}

function semRelease(sem: { active: number, max: number, waiters: Array<() => void> }) {
    sem.active = Math.max(0, sem.active - 1)
    const next = sem.waiters.shift()
    if (next) {
        sem.active++
        next()
    }
}

function getHostSem(url: string) {
    let host = 'default'
    try { host = new URL(url).hostname || 'default' } catch { /* ignore */ }
    let sem = hostSems.get(host)
    if (!sem) {
        sem = { active: 0, max: HOST_MAX_CONCURRENT, waiters: [] }
        hostSems.set(host, sem)
    }
    return { host, sem }
}

async function acquireCoverSlot(url: string): Promise<() => void> {
    const { host, sem: hostSem } = getHostSem(url)
    // 严格按 host -> global 顺序加锁，避免跨锁死锁；并允许不同域名互不阻塞
    await semAcquire(hostSem)
    try {
        await semAcquire(globalSem)
    } catch (e) {
        semRelease(hostSem)
        throw e
    }
    return () => {
        semRelease(globalSem)
        semRelease(hostSem)
        if (hostSem.active === 0 && hostSem.waiters.length === 0) {
            hostSems.delete(host)
        }
    }
}

/**
 * 尽力而为地按请求尺寸改写上游图片 URL（OpenSubsonic coverArtScaling）。
 *
 * 服务端没有 sharp（生产镜像 `npm install --omit=dev` 不会装它），无法真正缩放字节；
 * 但腾讯/网易的图片尺寸本来就编码在 URL 里，改写它就能拿到对应尺寸的图。
 * 无法识别的域名原样返回——客户端仍能正常显示，只是图更大。
 */
function applyImageSize(url: string, size: number): string {
    if (!url || !/^https?:\/\//.test(url) || !(size > 0)) return url
    const s = Math.max(16, Math.min(Math.floor(size), 1500))
    // 腾讯：.../T002R800x800M000<mid>.jpg
    if (/y\.gtimg\.cn\/.*\/T\d{3}R\d+x\d+M/.test(url)) {
        return url.replace(/(T\d{3}R)\d+x\d+(M)/, `$1${s}x${s}$2`)
    }
    // 网易：追加或替换 ?param=WxH
    if (/music\.126\.net/.test(url)) {
        const param = `${s}y${s}`
        if (/[?&]param=/.test(url)) return url.replace(/([?&]param=)[^&]*/, `$1${param}`)
        return url + (url.includes('?') ? '&' : '?') + `param=${param}`
    }
    return url
}

export interface CoverProxyOptions {
    fetchTimeoutMs?: number
    retryDelayMs?: number
    negativeTtlMs?: number
}

export function resetCoverProxyCacheForTest() {
    coverImageCache.clear()
    coverFailCache.clear()
    inFlightFetches.clear()
}

type FetchAttemptResult =
    | { ok: true, buf: Buffer, ct: string }
    | { ok: false, reason: 'http' | 'network' }

async function fetchSingleCover(fetchUrl: string, timeoutMs: number): Promise<FetchAttemptResult> {
    const appAgent = await getProxyAgent(fetchUrl, 'app')
    const release = await acquireCoverSlot(fetchUrl)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        // 开启 app 代理时改用 needle：原生 fetch 无法指定 agent
        if (appAgent) {
            const needle = (await import('needle')).default
            const r: any = await needle('get', fetchUrl, null, {
                agent: appAgent,
                response_timeout: timeoutMs,
                follow_max: 3,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
            } as any)
            const status: number = r?.statusCode || 0
            if (status < 200 || status >= 300) return { ok: false, reason: 'http' }
            const buf = Buffer.isBuffer(r?.body) ? r.body : Buffer.from(r?.raw || [])
            if (buf.length === 0) return { ok: false, reason: 'http' }
            const upstreamCt: string = r?.headers?.['content-type'] || ''
            const ct = upstreamCt.startsWith('image/') ? upstreamCt.split(';')[0].trim() : 'image/jpeg'
            return { ok: true, buf, ct }
        }

        const controller = new AbortController()
        timer = setTimeout(() => controller.abort(), timeoutMs)
        const imgResp = await fetch(fetchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
            signal: controller.signal,
        })
        if (!imgResp.ok) return { ok: false, reason: 'http' }
        const buf = Buffer.from(await imgResp.arrayBuffer())
        if (buf.length === 0) return { ok: false, reason: 'http' }
        // 读取上游真实的 Content-Type，兼容 jpeg、png、webp 等格式
        const upstreamCt = imgResp.headers.get('content-type')
        const ct = (upstreamCt && upstreamCt.startsWith('image/')) ? upstreamCt.split(';')[0].trim() : 'image/jpeg'
        return { ok: true, buf, ct }
    } catch (e) {
        console.error('[封面代理] 代理请求失败:', fetchUrl, (e as Error)?.message)
        return { ok: false, reason: 'network' }
    } finally {
        if (timer) clearTimeout(timer)
        release()
    }
}

async function fetchCoverWithRetries(
    picUrl: string,
    finalUrl: string,
    timeoutMs: number,
    retryDelayMs: number,
): Promise<{ buf: Buffer, ct: string } | null> {
    let lastReason: 'http' | 'network' = 'network'
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, retryDelayMs))
        const res = await fetchSingleCover(finalUrl, timeoutMs)
        if (res.ok) return { buf: res.buf, ct: res.ct }
        lastReason = res.reason
    }

    // [回退] 改写尺寸后的 URL 未必被上游支持（实测腾讯对过小尺寸会返回空/4xx），
    // 仅当上游确实返回 HTTP 错误或空响应时改用原始 URL 再取一次，网络不可达时不重复等待。
    if (finalUrl !== picUrl && lastReason === 'http') {
        const res = await fetchSingleCover(picUrl, timeoutMs)
        if (res.ok) return { buf: res.buf, ct: res.ct }
    }

    return null
}

/**
 * 代理并返回一张封面图片。
 * - 命中新鲜缓存直接返回（X-Cache: HIT）
 * - 命中短时失败负缓存直接返回 204，避免失效封面持续堵死队列
 * - 否则经按域名限流 + In-flight 去重回源抓取
 * - 全部失败且有过期缓存则降级返回（X-Cache: STALE），否则返回 204
 * @param size 期望边长（px），>0 时对可识别的图片源改写尺寸
 */
export async function proxyCoverImage(
    res: http.ServerResponse,
    picUrl: string,
    size?: number,
    options?: CoverProxyOptions,
) {
    // 尺寸作用在最终 URL 上，并按改写后的 URL 缓存（不同尺寸各自缓存一份）
    const finalUrl = size && size > 0 ? applyImageSize(picUrl, size) : picUrl
    const now = Date.now()
    const cached = coverImageCache.get(finalUrl)
    // 命中新鲜缓存直接返回，避免重复回源被图片 CDN 限流
    if (cached && now - cached.ts < COVER_CACHE_TTL) {
        if (res.destroyed || res.writableEnded) return
        res.writeHead(200, {
            'Content-Type': cached.ct,
            'Cache-Control': 'public, max-age=1800',
            'X-Cache': 'HIT',
        })
        return res.end(cached.buf)
    }

    const negativeTtlMs = options?.negativeTtlMs ?? COVER_FAIL_TTL
    const failTs = coverFailCache.get(finalUrl)
    if (!cached && failTs && now - failTs < negativeTtlMs) {
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
            res.writeHead(204, { 'X-Cache': 'NEGATIVE' })
            res.end()
        }
        return
    }

    if (res.destroyed || res.writableEnded) return

    const timeoutMs = options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

    let flight = inFlightFetches.get(finalUrl)
    if (!flight) {
        flight = fetchCoverWithRetries(picUrl, finalUrl, timeoutMs, retryDelayMs).finally(() => {
            inFlightFetches.delete(finalUrl)
        })
        inFlightFetches.set(finalUrl, flight)
    }

    const result = await flight

    if (result) {
        coverCacheSet(finalUrl, { ts: Date.now(), buf: result.buf, ct: result.ct })
        if (res.destroyed || res.writableEnded) return
        res.writeHead(200, {
            'Content-Type': result.ct,
            'Cache-Control': 'public, max-age=1800',
        })
        return res.end(result.buf)
    }

    // 回源彻底失败：若有过期缓存，降级返回避免封面彻底消失
    if (cached) {
        if (res.destroyed || res.writableEnded) return
        res.writeHead(200, {
            'Content-Type': cached.ct,
            'Cache-Control': 'public, max-age=300',
            'X-Cache': 'STALE',
        })
        return res.end(cached.buf)
    }

    coverFailSet(finalUrl, Date.now())
    if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        res.writeHead(204)
        res.end()
    }
}
