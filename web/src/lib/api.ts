import { authFields, expireAuth } from './auth'
import type { CloudFile, DirId } from './files'

export class ApiError extends Error {
  code?: string
  status: number
  constructor(message: string, status = 0, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let r: Response
  try {
    r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...authFields() }),
    })
  } catch {
    throw new ApiError('预览模式无后端', 404, 'PREVIEW')
  }
  if (r.status === 404) throw new ApiError('预览模式无后端', 404, 'PREVIEW')
  const raw = await r.text()
  if (!raw.trim() && r.status >= 500) throw new ApiError('预览模式无后端', r.status, 'PREVIEW')
  let data: { error?: string; code?: string } = {}
  if (raw) {
    try { data = JSON.parse(raw) as { error?: string; code?: string } }
    catch { throw new ApiError('服务端返回异常', r.status) }
  }
  if (r.status === 401) {
    expireAuth()
    throw new ApiError(data.error || '登录已过期，请重新输入密码', 401)
  }
  if (!r.ok) {
    const err = new ApiError(data.error || `请求失败 ${r.status}`, r.status, data.code)
    throw err
  }
  return data as T
}

export type AuthResult =
  | { ok: true; maxMB?: number; token?: string }
  | { ok: false; expired?: boolean; msg: string }
  | { preview: true }

export async function checkAuth(payload: { password?: string; auth?: string }): Promise<AuthResult> {
  try {
    const r = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: true, ...payload }),
    })
    if (r.status === 404) return { preview: true }
    const raw = await r.text()
    if (!raw.trim() && r.status >= 500) return { preview: true }
    const data = (raw ? JSON.parse(raw) : {}) as { error?: string; maxMB?: number; token?: string }
    if (r.ok) return { ok: true, maxMB: data.maxMB, token: data.token }
    if (r.status === 401) return { ok: false, expired: true, msg: data.error || '密码错误或会话已过期' }
    return { ok: false, msg: data.error || `服务端错误 ${r.status}` }
  } catch {
    return { preview: true }
  }
}

export function listFiles(dir: DirId, token = '') {
  return post<{ files?: CloudFile[]; nextToken?: string; truncated?: boolean }>('/api/list', { dir, token })
}

export function deleteFile(key: string) {
  return post('/api/delete', { key })
}

export function renameFile(key: string, name: string) {
  return post<{ key: string; url: string; warn?: string; oldKey?: string }>('/api/rename', { key, name })
}

export function moveFile(key: string, dir: string) {
  return post<{ key: string; url: string; warn?: string; oldKey?: string }>('/api/rename', { key, dir })
}
