import { toast } from 'sonner'
import { authFields, MP_KEY_NAME } from './auth'
import { ApiError } from './api'
import { fileTypeOf, fmtSize } from './files'

const MP_THRESHOLD = 10 * 1024 * 1024

export type QState = 'queued' | 'uploading' | 'paused' | 'done' | 'err'
export type QueueItem = {
  id: string
  file: File
  state: QState
  pct: number
  text: string
  tone?: 'ok' | 'err'
  paused: boolean
  cancelled: boolean
  currentXhr: XMLHttpRequest | null
  lastPct: number
}

type DoneInfo = { url: string; dir: string; key: string; size: number; name: string }

let maxSizeMB = 100
let uploading = false
const items: QueueItem[] = []
const pending: QueueItem[] = []
const listeners = new Set<() => void>()
let askName: (name: string) => Promise<string | null> = async () => null
let onDone: (info: DoneInfo) => void = () => {}

export function setMaxSizeMB(n: number) { maxSizeMB = n || 100 }
export function getMaxSizeMB() { return maxSizeMB }
export function setConflictAsker(fn: (name: string) => Promise<string | null>) { askName = fn }
export function setUploadDone(fn: (info: DoneInfo) => void) { onDone = fn }
export function subscribeQueue(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function getQueue() { return items }

function emit() { listeners.forEach((fn) => fn()) }

class UpErr extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}
const pausedErr = () => new UpErr('已暂停', 'PAUSED')
const cancelledErr = () => new UpErr('已取消', 'CANCELLED')

function keepName() { return localStorage.getItem('yunwo_keepname') !== '0' }
function webpOn() { return localStorage.getItem('yunwo_webp') === '1' }
function quality() { return Number(localStorage.getItem('yunwo_quality') || '82') }

function setQ(item: QueueItem, pct: number, text: string, tone?: 'ok' | 'err') {
  item.pct = pct
  item.text = text
  item.tone = tone
  item.lastPct = pct
  emit()
}

export function enqueue(files: File[]) {
  if (!files.length) return
  const maxBytes = maxSizeMB * 1024 * 1024
  const overs = files.filter((f) => f.size > maxBytes)
  overs.forEach((f) => toast.error(`${f.name} 超过 ${maxSizeMB}MB，已跳过`))
  const ok = files.filter((f) => f.size <= maxBytes)
  ok.forEach((file) => {
    const item: QueueItem = {
      id: crypto.randomUUID(),
      file,
      state: 'queued',
      pct: 0,
      text: `排队中 · ${fmtSize(file.size)}`,
      paused: false,
      cancelled: false,
      currentXhr: null,
      lastPct: 0,
    }
    items.push(item)
    pending.push(item)
  })
  emit()
  if (!uploading) void processQueue()
}

export function pauseItem(item: QueueItem) {
  if (item.state !== 'uploading') return
  item.paused = true
  if (item.currentXhr) { try { item.currentXhr.abort() } catch { /* ignore */ } }
  setQ(item, item.lastPct || 0, '正在暂停…')
}

export function resumeItem(item: QueueItem) {
  if (item.state !== 'paused') return
  item.paused = false
  item.state = 'queued'
  setQ(item, item.lastPct || 8, '排队等待继续上传…')
  pending.unshift(item)
  emit()
  void processQueue()
}

export async function cancelItem(item: QueueItem) {
  if (item.state === 'done' || item.state === 'err') {
    removeItem(item)
    return
  }
  item.cancelled = true
  item.paused = false
  const i = pending.indexOf(item)
  if (i >= 0) pending.splice(i, 1)
  if (item.currentXhr) { try { item.currentXhr.abort() } catch { /* ignore */ } }
  const fp = fpOf(item.file)
  const task = getMpTasks()[fp]
  if (task?.uploadId) {
    try { await mpApi({ action: 'abort', key: task.key, uploadId: task.uploadId, session: task.session || '' }) } catch { /* ignore */ }
    delMpTask(fp)
  }
  if (item.state !== 'uploading') removeItem(item)
}

function removeItem(item: QueueItem) {
  const i = items.indexOf(item)
  if (i >= 0) items.splice(i, 1)
  emit()
}

export function clearFinished() {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].state === 'done' || items[i].state === 'err') items.splice(i, 1)
  }
  emit()
}

async function maybeCompress(file: File) {
  if (!webpOn() || !file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file
  const img = new Image()
  const url = URL.createObjectURL(file)
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('decode'))
      img.src = url
    })
  } catch {
    URL.revokeObjectURL(url)
    return file
  }
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  c.getContext('2d')!.drawImage(img, 0, 0)
  URL.revokeObjectURL(url)
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/webp', quality() / 100))
  if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' })
  return file
}

function fmtSpeed(bps: number) {
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s'
  if (bps >= 1024) return Math.round(bps / 1024) + ' KB/s'
  return Math.max(1, Math.round(bps)) + ' B/s'
}

function makeProgress(item: QueueItem, file: File, textFn: (pct: number) => string) {
  let lastT = 0, lastB: number | null = null, speed = 0, lastPaint = 0
  return (bytesNow: number) => {
    const now = Date.now()
    if (lastB === null) { lastB = bytesNow; lastT = now }
    const dt = (now - lastT) / 1000
    if (dt >= 0.4) {
      const inst = (bytesNow - lastB) / dt
      speed = speed ? speed * 0.6 + inst * 0.4 : inst
      lastT = now
      lastB = bytesNow
    }
    if (now - lastPaint >= 300) {
      lastPaint = now
      const pct = bytesNow / (file.size || 1) * 100
      item.lastPct = Math.min(96, 2 + pct * 0.94)
      setQ(item, item.lastPct, textFn(pct) + (speed > 1024 ? ' · ' + fmtSpeed(speed) : ''))
    }
  }
}

async function getSign(file: File) {
  const sr = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size, keepName: keepName(), ...authFields() }),
  })
  if (sr.status === 404) throw new UpErr('预览模式无后端', 'PREVIEW')
  const sign = await sr.json().catch(() => ({})) as { error?: string; host?: string; url?: string; dir?: string; fields?: Record<string, string> }
  if (sr.status === 401) throw new UpErr('登录已过期，请重新输入密码')
  if (!sr.ok) throw new UpErr(sign.error || `签名失败 ${sr.status}`)
  return sign as { host: string; url: string; dir: string; fields: Record<string, string> }
}

function postToOSS(sign: { host: string; fields: Record<string, string> }, file: File, item: QueueItem, onProgress?: (n: number) => void) {
  const fd = new FormData()
  Object.entries(sign.fields).forEach(([k, v]) => fd.append(k, v))
  fd.append('file', file, file.name)
  return new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((resolve, reject) => {
    const x = new XMLHttpRequest()
    item.currentXhr = x
    x.open('POST', sign.host)
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded) }
    x.onload = () => {
      item.currentXhr = null
      resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, text: async () => x.responseText || '' })
    }
    x.onerror = () => {
      item.currentXhr = null
      if (item.paused) { reject(pausedErr()); return }
      if (item.cancelled) { reject(cancelledErr()); return }
      reject(new UpErr('网络中断（若反复出现，请检查桶 CORS 的来源是否包含本站域名）'))
    }
    x.onabort = () => {
      item.currentXhr = null
      reject(item.cancelled ? cancelledErr() : pausedErr())
    }
    x.send(fd)
  })
}

async function uploadSimple(item: QueueItem, file: File) {
  if (item.paused) throw pausedErr()
  if (item.cancelled) throw cancelledErr()
  setQ(item, 5, '获取签名…')
  let sign = await getSign(file)
  const progress = makeProgress(item, file, (pct) => '上传到 OSS · ' + Math.round(pct) + '%')
  let ur = await postToOSS(sign, file, item, progress)
  if (!ur.ok) {
    const t = await ur.text().catch(() => '')
    if (ur.status === 409 || /FileAlreadyExists/i.test(t)) throw new UpErr('同名文件已存在', 'CONFLICT')
    if (/Policy expired|AccessDenied/i.test(t)) {
      setQ(item, 5, '签名已过期，自动重签重传…')
      sign = await getSign(file)
      ur = await postToOSS(sign, file, item, progress)
      if (ur.status === 409) throw new UpErr('同名文件已存在', 'CONFLICT')
    }
  }
  if (!ur.ok) throw new UpErr('OSS 返回 ' + ur.status)
  return { url: sign.url, dir: sign.dir, key: sign.fields.key }
}

type MpTask = {
  key: string
  uploadId: string
  partSize: number
  session: string
  dir?: string
  mime: string
  parts: Record<string, string>
}

function getMpTasks(): Record<string, MpTask> {
  try { return JSON.parse(localStorage.getItem(MP_KEY_NAME) || '{}') as Record<string, MpTask> } catch { return {} }
}
function saveMpTask(fp: string, task: MpTask) {
  const all = getMpTasks()
  all[fp] = task
  localStorage.setItem(MP_KEY_NAME, JSON.stringify(all))
}
function delMpTask(fp: string) {
  const all = getMpTasks()
  delete all[fp]
  localStorage.setItem(MP_KEY_NAME, JSON.stringify(all))
}
function fpOf(file: File) { return file.name + '_' + file.size + '_' + file.lastModified }

async function mpApi(payload: Record<string, unknown>) {
  const r = await fetch('/api/multipart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, ...authFields() }),
  })
  if (r.status === 404) throw new UpErr('预览模式无后端', 'PREVIEW')
  const data = await r.json().catch(() => ({})) as { error?: string; code?: string }
  if (r.status === 401) throw new UpErr('登录已过期，请重新输入密码')
  if (!r.ok) throw new UpErr(data.error || `分片服务错误 ${r.status}`, data.code)
  return data as Record<string, unknown>
}

async function mpApiRetry(payload: Record<string, unknown>, tries = 3) {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await mpApi(payload) }
    catch (e) {
      lastErr = e
      const err = e as UpErr
      if (err.code) throw e
      if (!/net_exception|timeout|timed out|50[234]|failed to fetch|network/i.test(err.message || '')) throw e
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1200 * attempt))
    }
  }
  throw lastErr
}

function md5Hex(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  const n = bytes.length
  const bitLen = n * 8
  const padLen = ((n % 64) < 56 ? 56 : 120) - (n % 64)
  const total = n + padLen + 8
  const buf = new Uint8Array(total)
  buf.set(bytes)
  buf[n] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, bitLen >>> 0, true)
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true)
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
  const K = new Uint32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  const M = new Uint32Array(16)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true)
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F: number, g: number
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      const tmp = D
      const sum = (A + F + K[i] + M[g])
      D = C; C = B
      const s = S[i]
      B = (B + (((sum << s) | (sum >>> (32 - s))))) | 0
      A = tmp
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0
  }
  const out = new Uint8Array(16)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true)
  ov.setUint32(8, c0, true); ov.setUint32(12, d0, true)
  let hex = ''
  for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0')
  return hex
}

function xhrPut(url: string, blob: Blob, mime: string, md5Fallback: string, onProgress: (n: number) => void, item: QueueItem) {
  return new Promise<string>((resolve, reject) => {
    const x = new XMLHttpRequest()
    item.currentXhr = x
    x.open('PUT', url)
    x.setRequestHeader('Content-Type', mime)
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded) }
    const clear = () => { if (item.currentXhr === x) item.currentXhr = null }
    x.onload = () => {
      clear()
      if (x.status >= 200 && x.status < 300) {
        const etag = x.getResponseHeader('ETag')
        resolve((etag || md5Fallback || '').replace(/"/g, ''))
      } else {
        const m = (x.responseText || '').match(/<Code>([^<]+)<\/Code>/)
        const err = new UpErr('分片上传失败：' + (m ? m[1] : 'HTTP ' + x.status))
        if (/NoSuchUpload/.test(x.responseText || '')) err.code = 'NoSuchUpload'
        reject(err)
      }
    }
    x.onerror = () => {
      clear()
      if (item.paused) { reject(pausedErr()); return }
      if (item.cancelled) { reject(cancelledErr()); return }
      reject(new UpErr('网络中断（若反复出现，请检查桶 CORS 的来源是否包含本站域名、方法是否允许 PUT）'))
    }
    x.onabort = () => {
      clear()
      reject(item.cancelled ? cancelledErr() : pausedErr())
    }
    x.send(blob)
  })
}

async function uploadPartWithRetry(task: MpTask, n: number, chunk: Blob, onProgress: (n: number) => void, item: QueueItem) {
  const md5 = md5Hex(await chunk.arrayBuffer())
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (item.paused) throw pausedErr()
    if (item.cancelled) throw cancelledErr()
    try {
      const sign = await mpApi({ action: 'part', key: task.key, uploadId: task.uploadId, partNumber: n, mime: task.mime, session: task.session || '' }) as { url: string }
      const etag = await xhrPut(sign.url, chunk, task.mime, md5, onProgress, item)
      if (!etag) throw new UpErr('ETag 为空')
      return etag
    } catch (e) {
      if (item.paused) throw pausedErr()
      if (item.cancelled) throw cancelledErr()
      lastErr = e
      const err = e as UpErr
      if (err.code === 'NoSuchUpload' || err.code === 'BAD_SESSION') throw e
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  throw lastErr
}

async function uploadMultipart(item: QueueItem, file: File) {
  const fp = fpOf(file)
  for (let restarted = 0; restarted < 2; restarted++) {
    if (item.paused) throw pausedErr()
    if (item.cancelled) throw cancelledErr()
    const saved = getMpTasks()[fp]
    const resumed = !!(saved && saved.uploadId && saved.key)
    let task: MpTask
    try {
      if (!resumed) {
        setQ(item, 10, '初始化分片上传…')
        const init = await mpApiRetry({ action: 'init', filename: file.name, size: file.size, mime: file.type || 'application/octet-stream', keepName: keepName() }) as { key: string; uploadId: string; partSize: number; session?: string; dir?: string }
        task = { key: init.key, uploadId: init.uploadId, partSize: init.partSize, session: init.session || '', dir: init.dir, mime: file.type || 'application/octet-stream', parts: {} }
        saveMpTask(fp, task)
      } else {
        task = saved
        toast('检测到该文件有未完成的上传，自动断点续传')
      }
      const total = Math.ceil(file.size / task.partSize)
      const partBytes = (n: number) => Math.min(task.partSize, file.size - (n - 1) * task.partSize)
      let doneBytes = Object.keys(task.parts).reduce((s, k) => s + partBytes(+k), 0)
      let curPart = 1
      const progress = makeProgress(item, file, (pct) => `分片 ${curPart}/${total} 上传中 · ${Math.round(pct)}%`)
      for (let n = 1; n <= total; n++) {
        if (task.parts[n]) continue
        if (item.paused) throw pausedErr()
        if (item.cancelled) throw cancelledErr()
        curPart = n
        const start = (n - 1) * task.partSize
        const chunk = file.slice(start, start + partBytes(n))
        const etag = await uploadPartWithRetry(task, n, chunk, (loaded) => {
          if (item.paused || item.cancelled) { if (item.currentXhr) item.currentXhr.abort(); return }
          progress(doneBytes + loaded)
        }, item)
        task.parts[n] = etag
        saveMpTask(fp, task)
        doneBytes += partBytes(n)
        item.lastPct = 2 + (doneBytes / (file.size || 1)) * 94
        setQ(item, item.lastPct, `分片 ${n}/${total} 完成 · ${Math.round(doneBytes / (file.size || 1) * 100)}%`)
      }
      setQ(item, 97, '合并分片…')
      const parts = Object.keys(task.parts).map((k) => ({ partNumber: +k, etag: task.parts[k] })).sort((a, b) => a.partNumber - b.partNumber)
      const done = await mpApiRetry({ action: 'complete', key: task.key, uploadId: task.uploadId, session: task.session || '', parts }) as { url: string; dir: string; key: string }
      delMpTask(fp)
      return { url: done.url, dir: done.dir, key: done.key }
    } catch (e) {
      const err = e as UpErr
      if (err.code === 'PAUSED' || err.code === 'CANCELLED') throw e
      if ((err.code === 'NoSuchUpload' || err.code === 'BAD_SESSION') && restarted === 0) {
        delMpTask(fp)
        setQ(item, 10, '续传会话已过期，自动重新开始…')
        continue
      }
      throw e
    }
  }
  throw new UpErr('上传失败')
}

function randCode6() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const buf = new Uint8Array(6)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => chars[b % 36]).join('')
}
function addConflictSuffix(name: string) {
  const i = name.lastIndexOf('.')
  const code = randCode6()
  return i > 0 ? name.slice(0, i) + '-' + code + name.slice(i) : name + '-' + code
}

async function processQueue() {
  if (uploading) return
  uploading = true
  emit()
  while (pending.length) {
    const item = pending.shift()!
    if (item.cancelled) { removeItem(item); continue }
    item.state = 'uploading'
    emit()
    try {
      setQ(item, item.lastPct || 8, fileTypeOf(item.file.name) === 'image' ? '压缩处理中…' : '准备上传…')
      let file = await maybeCompress(item.file)
      let result: { url: string; dir: string; key: string } | undefined
      for (;;) {
        if (item.paused) throw pausedErr()
        if (item.cancelled) throw cancelledErr()
        try {
          result = file.size > MP_THRESHOLD ? await uploadMultipart(item, file) : await uploadSimple(item, file)
          break
        } catch (e) {
          const err = e as UpErr
          if (err.code !== 'CONFLICT') throw e
          setQ(item, 100, '同名文件已存在，等待处理…', 'err')
          const choice = await askName(file.name)
          if (choice === null) throw new UpErr('已取消（同名文件冲突）')
          const newName = choice === '__auto__' ? addConflictSuffix(file.name) : choice
          file = new File([file], newName, { type: file.type, lastModified: file.lastModified })
          setQ(item, 8, '以新名称重新上传…')
        }
      }
      item.state = 'done'
      setQ(item, 100, `完成 · ${fmtSize(file.size)} → ${result!.dir}`, 'ok')
      onDone({ url: result!.url, dir: result!.dir, key: result!.key, size: file.size, name: file.name })
      toast.success(file.name + ' 上传成功')
    } catch (e) {
      const err = e as UpErr
      if (err.code === 'PAUSED') {
        item.state = 'paused'
        setQ(item, item.lastPct || 0, '已暂停 · 点「继续」接着传')
        continue
      }
      if (err.code === 'CANCELLED') { removeItem(item); continue }
      if (err instanceof ApiError && err.code === 'PREVIEW') {
        item.state = 'err'
        setQ(item, 100, '预览模式无后端', 'err')
        toast.error('预览模式无后端')
        continue
      }
      item.state = 'err'
      setQ(item, 100, err.message || '上传失败', 'err')
      toast.error('上传失败：' + (err.message || '未知错误'))
    }
  }
  uploading = false
  emit()
}

export function queueSummary() {
  const list = items
  const done = list.filter((i) => i.state === 'done').length
  const fail = list.filter((i) => i.state === 'err').length
  const pausedN = list.filter((i) => i.state === 'paused').length
  const active = uploading
  const agg = list.length ? list.reduce((s, i) => s + (i.pct || 0), 0) / list.length : 0
  let title = '传输'
  if (!list.length) title = '传输'
  else if (active) title = `上传中 ${done + fail}/${list.length}` + (pausedN ? ` · 暂停 ${pausedN}` : '')
  else if (!fail && !pausedN && done === list.length) title = `已完成 ${list.length} 个文件`
  else {
    const parts = []
    if (done) parts.push(`完成 ${done} 个`)
    if (fail) parts.push(`失败 ${fail} 个`)
    if (pausedN) parts.push(`暂停 ${pausedN} 个`)
    title = parts.join(' · ') || `共 ${list.length} 个`
  }
  return { title, agg, done, fail, pausedN, active, count: list.length }
}
