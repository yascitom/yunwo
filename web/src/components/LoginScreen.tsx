import { useState } from 'react'
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
  const [err, setErr] = useState(bootMsg)
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(false)

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
    <div className="grid min-h-svh place-items-center bg-background px-4">
      <div className={`w-full max-w-sm rounded-2xl border bg-card p-8 shadow-xl ${shake ? 'animate-shake' : ''}`}>
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
          <Cloud className="size-5" />
        </div>
        <h1 className="text-center text-xl font-semibold tracking-tight">云窝</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">私有网盘 · 登录有效 7 天</p>
        <form className="mt-6 space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(password) }}>
          <Input
            type="password"
            autoFocus
            placeholder="访问密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 text-center"
          />
          <Button type="submit" className="h-11 w-full" disabled={busy}>
            {busy ? '验证中…' : '进入'}
          </Button>
        </form>
        {err ? <p className="mt-3 text-center text-sm text-destructive">{err}</p> : null}
        <a className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground" href="https://github.com/yascitom/yunwo" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
    </div>
  )
}
