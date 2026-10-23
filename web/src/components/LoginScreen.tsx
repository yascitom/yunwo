import { useEffect, useState } from 'react'
import { Cloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { checkAuth } from '@/lib/api'
import { getToken, saveToken } from '@/lib/auth'
import { useDrive } from '@/store'

const DEMO = 'demo1234'

export function LoginScreen() {
  const setUnlocked = useDrive((s) => s.setUnlocked)
  const bootMsg = useDrive((s) => s.bootMsg)
  const setBootMsg = useDrive((s) => s.setBootMsg)
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(false)

  useEffect(() => { if (bootMsg) setErr(bootMsg) }, [bootMsg])

  function bump(msg: string) {
    setErr(msg)
    setShake(true)
    window.setTimeout(() => setShake(false), 400)
  }

  async function submit(value: string) {
    setBusy(true)
    const r = await checkAuth(value ? { password: value } : { auth: getToken() || ' ' })
    setBusy(false)
    if ('preview' in r) {
      if (value === DEMO || (!value && !getToken())) {
        if (value === DEMO) { setUnlocked(true, true); setBootMsg(''); return }
      }
      if (value && value !== DEMO) bump('预览演示模式，请输入演示密码：demo1234')
      return
    }
    if (r.ok) {
      if (r.token) {
        saveToken(r.token)
        setUnlocked(true, false, r.maxMB)
      } else bump('服务端未签发登录令牌，请将后端函数更新到最新版本')
      return
    }
    bump(r.msg)
  }

  return (
    <div className="relative grid min-h-svh place-items-center bg-background px-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(ellipse_at_top,oklch(0.62_0.05_255/0.28),transparent_68%)]" />
      <div className={`glass relative w-full max-w-[360px] rounded-2xl border p-8 shadow-sm ${shake ? 'animate-shake' : ''}`}>
        <div className="mx-auto mb-5 grid size-11 place-items-center rounded-xl bg-foreground text-background">
          <Cloud className="size-5" />
        </div>
        <h1 className="text-center text-xl font-semibold tracking-tight">云窝</h1>
        <p className="mt-1.5 text-center text-sm text-muted-foreground">私有网盘 · 登录有效 7 天</p>
        <form className="mt-7 space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(password) }}>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">访问密码</span>
            <Input
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10"
            />
          </label>
          <Button type="submit" className="h-10 w-full" disabled={busy}>
            {busy ? '验证中…' : '进入'}
          </Button>
        </form>
        {err ? <p className="mt-3 text-center text-sm leading-relaxed text-destructive">{err}</p> : null}
        <button
          type="button"
          className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => void submit(DEMO)}
        >
          演示预览 · demo1234
        </button>
        <a className="mt-6 flex items-center justify-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href="https://github.com/yascitom/yunwo" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
    </div>
  )
}
