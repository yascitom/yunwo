import { useEffect } from 'react'
import { LoginScreen } from '@/components/LoginScreen'
import { Drive } from '@/components/Drive'
import { checkAuth } from '@/lib/api'
import { clearSession, getToken, onAuthExpired, saveToken } from '@/lib/auth'
import { useDrive } from '@/store'

export default function App() {
  const unlocked = useDrive((s) => s.unlocked)
  const setUnlocked = useDrive((s) => s.setUnlocked)
  const setBootMsg = useDrive((s) => s.setBootMsg)

  useEffect(() => {
    return onAuthExpired(() => {
      clearSession()
      setUnlocked(false)
      setBootMsg('登录已过期，请重新输入密码')
    })
  }, [setUnlocked, setBootMsg])

  useEffect(() => {
    const token = getToken()
    void (async () => {
      if (token) {
        const r = await checkAuth({ auth: token })
        if ('preview' in r) { setUnlocked(true, true); return }
        if (r.ok) {
          if (r.token) saveToken(r.token)
          else { setBootMsg('服务端未签发登录令牌，请将后端函数更新到最新版本'); return }
          setUnlocked(true, false, r.maxMB)
          return
        }
        setBootMsg(r.msg)
        return
      }
      const r = await checkAuth({ password: localStorage.getItem('yunwo_pwd') || '' })
      if ('preview' in r) return
      if (r.ok && r.token) { saveToken(r.token); setUnlocked(true, false, r.maxMB) }
    })()
  }, [setUnlocked, setBootMsg])

  return unlocked ? <Drive /> : <LoginScreen />
}
