const TOKEN_KEY = 'yunwo_token'
const PWD_KEY = 'yunwo_pwd'
const HIST_KEY = 'yunwo_history'
const MP_KEY = 'yunwo_multipart_tasks'

;(function migrateLegacyKeys() {
  const pairs: [string, string][] = [
    ['oss_imgbed_history', HIST_KEY],
    ['oss_imgbed_pwd', PWD_KEY],
    ['yt_multipart_tasks', MP_KEY],
  ]
  pairs.forEach(([oldK, newK]) => {
    const v = localStorage.getItem(oldK)
    if (v !== null && localStorage.getItem(newK) === null) localStorage.setItem(newK, v)
    if (v !== null) localStorage.removeItem(oldK)
  })
})()

const expiredListeners = new Set<() => void>()
export function onAuthExpired(fn: () => void) {
  expiredListeners.add(fn)
  return () => { expiredListeners.delete(fn) }
}
export function expireAuth() {
  localStorage.removeItem(TOKEN_KEY)
  expiredListeners.forEach((fn) => fn())
}

export function getToken() {
  try {
    const o = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null') as { t?: string; e?: number } | null
    if (o && o.t && o.e && o.e > Math.floor(Date.now() / 1000) + 60) return o.t
  } catch { /* ignore */ }
  return ''
}

export function saveToken(t: string) {
  try {
    const body = t.slice(0, t.lastIndexOf('.'))
    const p = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { e?: number }
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ t, e: p.e || 0 }))
  } catch { /* ignore */ }
  localStorage.removeItem(PWD_KEY)
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(PWD_KEY)
}

export function authFields(): { auth: string } | Record<string, never> {
  const t = getToken()
  return t ? { auth: t } : {}
}

export const HIST_KEY_NAME = HIST_KEY
export const MP_KEY_NAME = MP_KEY

export type HistItem = { url: string; t: number }
export function getHist(): HistItem[] {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]') as HistItem[] } catch { return [] }
}
export function addHist(url: string) {
  const h = getHist()
  h.unshift({ url, t: Date.now() })
  localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 60)))
}
export function clearHist() {
  localStorage.removeItem(HIST_KEY)
}
