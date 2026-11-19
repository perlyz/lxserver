import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { proxyCoverImage, resetCoverProxyCacheForTest } from '../src/server/media/coverProxy'

function createMockRes() {
  const chunks: Buffer[] = []
  let statusCode = 0
  let headers: Record<string, string> = {}
  const stream = new PassThrough()
  const res: any = stream
  res.headersSent = false
  res.writableEnded = false
  res.writeHead = (code: number, hdrs: Record<string, string> = {}) => {
    statusCode = code
    headers = { ...headers, ...hdrs }
    res.headersSent = true
  }
  const origWrite = stream.write.bind(stream)
  res.write = (chunk: any) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return origWrite(chunk)
  }
  const done = new Promise<{ statusCode: number, headers: Record<string, string>, body: Buffer }>((resolve) => {
    const origEnd = stream.end.bind(stream)
    res.end = (chunk?: any) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      res.writableEnded = true
      origEnd()
      resolve({ statusCode, headers, body: Buffer.concat(chunks) })
    }
  })
  return { res: res as http.ServerResponse, done }
}

async function withServer(handler: http.RequestListener, fn: (port: number) => Promise<void>) {
  const srv = http.createServer(handler)
  await new Promise<void>(resolve => srv.listen(0, () => resolve()))
  const addr = srv.address() as { port: number }
  try {
    await fn(addr.port)
  } finally {
    srv.closeAllConnections()
    await new Promise<void>(resolve => srv.close(() => resolve()))
  }
}

test('deduplicates concurrent in-flight cover fetches and hits memory cache afterwards', async () => {
  resetCoverProxyCacheForTest()
  let hits = 0
  await withServer((_req, res) => {
    hits++
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(Buffer.from('PNGDATA'))
    }, 30)
  }, async (port) => {
    const url = `http://127.0.0.1:${port}/cover.png`
    const callers = [createMockRes(), createMockRes(), createMockRes(), createMockRes()]
    await Promise.all(callers.map(c => proxyCoverImage(c.res, url, 0, { fetchTimeoutMs: 1000, retryDelayMs: 10 })))
    const results = await Promise.all(callers.map(c => c.done))

    assert.equal(hits, 1)
    for (const r of results) {
      assert.equal(r.statusCode, 200)
      assert.equal(r.headers['Content-Type'], 'image/png')
      assert.equal(r.body.toString(), 'PNGDATA')
    }

    const cachedCaller = createMockRes()
    await proxyCoverImage(cachedCaller.res, url, 0)
    const cachedRes = await cachedCaller.done
    assert.equal(hits, 1)
    assert.equal(cachedRes.statusCode, 200)
    assert.equal(cachedRes.headers['X-Cache'], 'HIT')
  })
})

test('slow/hanging host does not starve another host and enforces per-host concurrency cap', async () => {
  resetCoverProxyCacheForTest()
  let slowInFlight = 0
  let maxSlowInFlight = 0

  await withServer((req, res) => {
    if (req.url?.startsWith('/slow')) {
      slowInFlight++
      maxSlowInFlight = Math.max(maxSlowInFlight, slowInFlight)
      setTimeout(() => {
        slowInFlight--
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        res.end(Buffer.from('SLOW'))
      }, 250)
      return
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' })
    res.end(Buffer.from('FAST'))
  }, async (port) => {
    const slowCalls = [0, 1, 2].map(i => {
      const c = createMockRes()
      const p = proxyCoverImage(c.res, `http://127.0.0.1:${port}/slow-${i}.jpg`, 0, { fetchTimeoutMs: 2000, retryDelayMs: 10 })
      return { c, p }
    })

    // Give slow calls a tick to occupy 127.0.0.1's 2 host slots, then request fast cover via localhost host key
    await new Promise(r => setTimeout(r, 20))
    const fastCaller = createMockRes()
    const t0 = Date.now()
    await proxyCoverImage(fastCaller.res, `http://localhost:${port}/fast.jpg`, 0, { fetchTimeoutMs: 2000, retryDelayMs: 10 })
    const fastMs = Date.now() - t0
    const fastRes = await fastCaller.done

    assert.equal(fastRes.statusCode, 200)
    assert.equal(fastRes.body.toString(), 'FAST')
    assert.ok(fastMs < 150, `expected fast host not to be blocked by slow host, took ${fastMs}ms`)

    await Promise.all(slowCalls.map(s => s.p))
    assert.equal(maxSlowInFlight, 2)
  })
})

test('caches failing covers briefly so repeated requests return 204 immediately', async () => {
  resetCoverProxyCacheForTest()
  let hits = 0
  await withServer((_req, res) => {
    hits++
    res.writeHead(502)
    res.end()
  }, async (port) => {
    const url = `http://127.0.0.1:${port}/bad.jpg`
    const first = createMockRes()
    await proxyCoverImage(first.res, url, 0, { fetchTimeoutMs: 500, retryDelayMs: 10, negativeTtlMs: 5000 })
    const firstRes = await first.done
    assert.equal(firstRes.statusCode, 204)
    assert.equal(hits, 2)

    const second = createMockRes()
    await proxyCoverImage(second.res, url, 0, { fetchTimeoutMs: 500, retryDelayMs: 10, negativeTtlMs: 5000 })
    const secondRes = await second.done
    assert.equal(secondRes.statusCode, 204)
    assert.equal(secondRes.headers['X-Cache'], 'NEGATIVE')
    assert.equal(hits, 2)
  })
})
