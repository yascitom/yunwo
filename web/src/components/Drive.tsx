import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode, type RefObject } from 'react'
import { toast } from 'sonner'
import QRCode from 'qrcode'
import {
  ArrowDownUp, Box, CheckIcon, ChevronDown, ChevronRight, Clock, Cloud, Columns2, File as FileIcon, Film, Folder, Image as ImageIcon, LayoutGrid, LogOut, Moon, MoreHorizontal,
  Pause, Play, RefreshCw, Rows3, Search, Sun, Trash2, Upload, X,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { Switch as Toggle } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { clearSession } from '@/lib/auth'
import { DIRS, dirLabel, dirOf, fileMeta, fileNameOf, fileTypeOf, filterFiles, formatLink, sortFiles, thumbUrl, type CloudFile, type DirId, type LinkFmt } from '@/lib/files'
import { cancelItem, clearFinished, enqueue, getMaxSizeMB, getQueue, pauseItem, queueSummary, resumeItem, setConflictAsker, setUploadDone, subscribeQueue, type QueueItem } from '@/lib/upload'
import { isPicked, pickedSelector, useDrive } from '@/store'

function useQueue() {
  return useSyncExternalStore(subscribeQueue, getQueue, getQueue)
}
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)')
    const fn = () => setNarrow(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  return narrow
}
function useListRowH() {
  const [h, setH] = useState(() => (window.matchMedia('(min-width: 640px)').matches ? 48 : 64))
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const apply = () => setH(mq.matches ? 48 : 64)
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return h
}

function IconTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  )
}

function navClass(active: boolean, over = false) {
  return `flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm ${active ? 'file-selected font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'} ${over ? 'ring-1 ring-foreground/15' : ''}`
}

const askDeleteRef: { current: (keys: string[], quiet?: boolean) => void } = { current: () => {} }
const clearArmedRef: { current: () => void } = { current: () => {} }
const draggingKeys: { current: string[] } = { current: [] }
const visibleRef: { current: CloudFile[] } = { current: [] }
const narrowRef = { current: typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches }

function openFile(f: CloudFile) {
  const t = f.type || fileTypeOf(f.key)
  if (t === 'image' || t === 'video') useDrive.getState().openLight(f)
  else window.open(f.url, '_blank', 'noopener,noreferrer')
}

async function copyFiles(files: CloudFile[], fmt?: LinkFmt) {
  const useFmt = fmt || useDrive.getState().fmt
  const text = files.map((f) => formatLink(f, useFmt)).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    toast.success((useFmt === 'url' ? '链接' : useFmt) + '已复制')
  } catch { toast.error('复制失败') }
}

function pickedFiles(file: CloudFile) {
  const st = useDrive.getState()
  if (!isPicked(st.selected, file.key)) return [file]
  const want = new Set(st.selected)
  return st.files.filter((f) => want.has(f.key))
}

function downloadFile(f: CloudFile) {
  const a = document.createElement('a')
  a.href = f.url
  a.download = fileNameOf(f.key)
  a.target = '_blank'
  a.rel = 'noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
  toast.success('已发起下载')
}

function stepLight(d: number) {
  const st = useDrive.getState()
  if (!st.light) return
  const visible = visibleRef.current
  const i = visible.findIndex((f) => f.key === st.light!.key)
  if (i < 0) return
  st.openLight(visible[(i + d + visible.length) % visible.length])
}

function oneFile(s: { selected: string[]; files: CloudFile[] }) {
  if (s.selected.length !== 1) return null
  for (let i = 0; i < s.files.length; i++) if (s.files[i].key === s.selected[0]) return s.files[i]
  return null
}

function hasFileDrag(e: { dataTransfer: DataTransfer | null }) {
  const types = e.dataTransfer?.types
  if (!types) return false
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true
  return false
}

let thumbMode: 'try' | 'off' = 'try'
let thumbProbe = false
const thumbListeners = new Set<() => void>()

function disableThumbs() {
  if (thumbMode === 'off') return
  thumbMode = 'off'
  thumbListeners.forEach((fn) => fn())
}
function thumbAllowed() { return thumbMode !== 'off' }

const videoPosters = new Map<string, string>()
const videoWatchers = new Map<Element, (on: boolean) => void>()
const videoVisible = new Set<Element>()
const videoShown = new Set<Element>()
const videoLoadingEls = new Set<Element>()
let videoIo: IntersectionObserver | null = null
const VIDEO_LOADS = 3

function pumpVideos() {
  for (const el of [...videoShown]) {
    if (videoVisible.has(el)) continue
    videoShown.delete(el)
    videoLoadingEls.delete(el)
    videoWatchers.get(el)?.(false)
  }
  for (const el of videoVisible) {
    if (videoLoadingEls.size >= VIDEO_LOADS) break
    if (videoShown.has(el)) continue
    videoLoadingEls.add(el)
    videoShown.add(el)
    videoWatchers.get(el)?.(true)
  }
}
function releaseVideoLoad(el: Element) {
  if (!videoLoadingEls.delete(el)) return
  pumpVideos()
}
function syncVideo(el: Element) {
  if (!videoWatchers.has(el)) return
  const rect = el.getBoundingClientRect()
  const vh = window.innerHeight || 800
  const vw = window.innerWidth || 1200
  const on = rect.width > 0 && rect.height > 0 && rect.bottom > -160 && rect.top < vh + 160 && rect.right > 0 && rect.left < vw
  if (on) videoVisible.add(el)
  else videoVisible.delete(el)
  pumpVideos()
}
function watchVideo(el: Element, cb: (on: boolean) => void) {
  videoWatchers.set(el, cb)
  if (!videoIo) {
    videoIo = new IntersectionObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        if (!videoWatchers.has(entry.target)) continue
        changed = true
        if (entry.isIntersecting) videoVisible.add(entry.target)
        else videoVisible.delete(entry.target)
      }
      if (changed) pumpVideos()
    }, { root: null, rootMargin: '120px 0px' })
  }
  videoIo.observe(el)
  const raf = requestAnimationFrame(() => syncVideo(el))
  return () => {
    cancelAnimationFrame(raf)
    videoWatchers.delete(el)
    videoVisible.delete(el)
    videoShown.delete(el)
    const wasLoading = videoLoadingEls.delete(el)
    videoIo?.unobserve(el)
    if (wasLoading) pumpVideos()
  }
}

function gridLayout(width: number) {
  const inner = Math.max(168, width - 32)
  const gap = 12
  const min = 168
  const cols = Math.max(1, Math.floor((inner + gap) / (min + gap)))
  const colW = (inner - gap * (cols - 1)) / cols
  return { cols, rowH: colW + gap }
}

export function Drive() {
  const [menu, setMenu] = useState<{ x: number; y: number; file: CloudFile } | null>(null)
  const [sheet, setSheet] = useState(false)
  const [drop, setDrop] = useState(false)
  const [conflict, setConflict] = useState<{ name: string; resolve: (v: string | null) => void } | null>(null)
  const [conflictInput, setConflictInput] = useState('')
  const [qr, setQr] = useState<{ url: string; img: string } | null>(null)
  const [side, setSide] = useState(false)
  const [armed, setArmed] = useState(false)
  const [xfer, setXfer] = useState(false)
  const conflictRef = useRef<{ name: string; resolve: (v: string | null) => void } | null>(null)
  const armedRef = useRef(false)
  const armTimer = useRef(0)
  const xferRef = useRef(false)
  const dropRef = useRef(false)
  const uiRef = useRef({ menu, qr, conflict, sheet, side })

  useEffect(() => { void useDrive.getState().load(false) }, [])
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)')
    narrowRef.current = mq.matches
    const fn = () => { narrowRef.current = mq.matches }
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  useEffect(() => {
    setConflictAsker((name) => new Promise((resolve) => {
      const entry = { name, resolve }
      conflictRef.current = entry
      setConflictInput(name)
      setConflict(entry)
    }))
    setUploadDone((info) => {
      const st = useDrive.getState()
      st.remember(info.url)
      st.prepend({ key: info.key, url: info.url, size: info.size, time: new Date().toISOString(), type: fileTypeOf(info.key) })
    })
    return () => {
      setConflictAsker(async () => null)
      const open = conflictRef.current
      if (open) {
        open.resolve(null)
        conflictRef.current = null
        setConflict(null)
      }
    }
  }, [])

  useEffect(() => {
    let timer = 0
    const over = (e: DragEvent) => {
      if (!hasFileDrag(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      if (!dropRef.current) {
        dropRef.current = true
        setDrop(true)
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        dropRef.current = false
        setDrop(false)
      }, 180)
    }
    const dropEv = (e: DragEvent) => {
      if (!hasFileDrag(e)) return
      e.preventDefault()
      window.clearTimeout(timer)
      dropRef.current = false
      setDrop(false)
      const list = e.dataTransfer?.files
      if (list?.length) enqueue([...list])
    }
    const paste = (e: ClipboardEvent) => {
      const found = e.clipboardData?.items
      if (!found) return
      const files: File[] = []
      for (let i = 0; i < found.length; i++) {
        if (!found[i].type.startsWith('image/')) continue
        const file = found[i].getAsFile()
        if (file) files.push(file)
      }
      if (files.length) enqueue(files)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', dropEv)
    window.addEventListener('paste', paste)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', dropEv)
      window.removeEventListener('paste', paste)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = uiRef.current
      const st = useDrive.getState()
      const tag = document.activeElement?.tagName || ''
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === 'Escape') {
        if (ui.menu) { setMenu(null); return }
        if (ui.qr) { setQr(null); return }
        if (st.renameFor || ui.conflict) return
        if (st.light) { st.openLight(null); return }
        if (ui.sheet) { setSheet(false); return }
        if (ui.side) { setSide(false); return }
        clearArmedRef.current()
        st.clearSel()
        return
      }
      if (typing || xferRef.current || st.recent) return
      const current = oneFile(st)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        st.selectAll(visibleRef.current.map((f) => f.key))
      } else if (e.key === 'Delete' && st.selected.length && !st.light && !st.renameFor && !ui.conflict) {
        askDeleteRef.current(st.selected)
      } else if (e.key === 'Enter' && current && !st.light) {
        openFile(current)
      } else if (st.light && e.key === 'ArrowRight') stepLight(1)
      else if (st.light && e.key === 'ArrowLeft') stepLight(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const askDelete = useCallback((keys: string[], quiet = false) => {
    if (!keys.length) return
    if (!armedRef.current) {
      armedRef.current = true
      setArmed(true)
      window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => {
        armedRef.current = false
        setArmed(false)
      }, 3000)
      if (!quiet) toast.message(`再按 Delete 或再点「删除」确认（${keys.length} 个）`)
      return
    }
    window.clearTimeout(armTimer.current)
    armedRef.current = false
    setArmed(false)
    void useDrive.getState().removeKeys(keys)
  }, [])
  useEffect(() => {
    askDeleteRef.current = askDelete
    clearArmedRef.current = () => {
      if (!armedRef.current) return
      window.clearTimeout(armTimer.current)
      armedRef.current = false
      setArmed(false)
    }
    xferRef.current = xfer
    uiRef.current = { menu, qr, conflict, sheet, side }
  })

  const onUpload = useCallback(() => { document.getElementById('file-pick')?.click() }, [])
  const showQr = useCallback(async (url: string) => {
    const img = await QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
    setQr({ url, img })
  }, [])
  const onRename = useCallback((f: CloudFile) => { useDrive.getState().setRenameFor(f) }, [])
  const onDelete = useCallback((key: string) => { askDeleteRef.current([key]) }, [])
  const onPickDir = useCallback((id: DirId) => {
    setXfer(false)
    setSide(false)
    clearArmedRef.current()
    useDrive.getState().setDir(id)
  }, [])
  const onTransfer = useCallback(() => {
    setXfer(true)
    const st = useDrive.getState()
    st.setRecent(false)
    st.clearSel()
    clearArmedRef.current()
    setSide(false)
    setSheet(false)
  }, [])
  const onRecent = useCallback(() => {
    setXfer(false)
    const st = useDrive.getState()
    st.setRecent(true)
    st.clearSel()
    clearArmedRef.current()
    setSide(false)
    setSheet(false)
  }, [])
  const onRowClick = useCallback((e: ReactMouseEvent, f: CloudFile) => {
    if ((e.target as HTMLElement).closest('[data-stop]')) return
    if (e.detail > 1) return
    const st = useDrive.getState()
    const multi = e.shiftKey || e.ctrlKey || e.metaKey
    if (narrowRef.current && !multi) {
      if (st.selected.length === 1 && st.selected[0] === f.key) { st.clearSel(); setSheet(false); return }
      st.selectOnly(f.key)
      setSheet(true)
      return
    }
    if (e.shiftKey) st.selectRange(f.key, visibleRef.current.map((x) => x.key))
    else if (e.ctrlKey || e.metaKey) st.toggleKey(f.key)
    else if (st.selected.length === 1 && st.selected[0] === f.key) st.clearSel()
    else st.selectOnly(f.key)
  }, [])
  const onDouble = useCallback((f: CloudFile) => openFile(f), [])
  const onCheck = useCallback((key: string) => useDrive.getState().toggleKey(key), [])
  const onMenu = useCallback((e: ReactMouseEvent, f: CloudFile) => {
    e.preventDefault()
    useDrive.getState().selectOnly(f.key)
    setMenu({ x: e.clientX, y: e.clientY, file: f })
  }, [])
  const onDragStart = useCallback((e: ReactDragEvent, f: CloudFile) => {
    const sel = useDrive.getState().selected
    const keys = isPicked(sel, f.key) ? [...sel] : [f.key]
    draggingKeys.current = keys
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', keys.join('\n')) } catch { /* ignore */ }
    const ghost = document.createElement('div')
    ghost.textContent = keys.length > 1 ? `移动 ${keys.length} 个文件` : fileMeta(f).name
    ghost.style.cssText = 'position:fixed;top:-80px;left:-240px;max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:6px 10px;border-radius:8px;background:#161616;color:#fff;font-size:12px;pointer-events:none;'
    document.body.appendChild(ghost)
    try { e.dataTransfer.setDragImage(ghost, 12, 16) } catch { /* ignore */ }
    const dropGhost = () => ghost.remove()
    window.addEventListener('dragend', dropGhost, { once: true })
  }, [])

  function resolveConflict(v: string | null) {
    const open = conflictRef.current || conflict
    if (!open) return
    open.resolve(v)
    conflictRef.current = null
    setConflict(null)
  }

  return (
    <div className="shell-bg relative flex h-svh min-h-0 text-foreground">
      <SideNav xfer={xfer} side={side} onClose={() => setSide(false)} onPickDir={onPickDir} onTransfer={onTransfer} onRecent={onRecent} />
      {side ? <button className="fixed inset-y-0 right-0 left-60 z-30 bg-black/15 md:hidden" onClick={() => setSide(false)} aria-label="关闭目录" /> : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <PreviewBanner />
        <TopBar xfer={xfer} armed={armed} ask={askDelete} onUpload={onUpload} onOpenSide={() => setSide(true)} />
        <FileBody xfer={xfer} onUpload={onUpload} onClick={onRowClick} onDouble={onDouble} onCheck={onCheck} onMenu={onMenu} onDragStart={onDragStart} />
      </div>

      <DeskInspector xfer={xfer} onQr={showQr} onRename={onRename} onDelete={onDelete} />
      <MobileDetails xfer={xfer} sheet={sheet} setSheet={setSheet} onQr={showQr} onRename={onRename} onDelete={onDelete} />
      <ArmReset />

      {menu ? <button type="button" className="fixed inset-0 z-40 cursor-default" aria-label="关闭菜单" onClick={() => setMenu(null)} /> : null}
      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} onQr={showQr} onDelete={askDelete} /> : null}

      <LightDialog />
      <RenameDialog />

      <Dialog open={!!conflict} onOpenChange={(o) => { if (!o) resolveConflict(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>已存在同名文件</DialogTitle></DialogHeader>
          <p className="text-xs leading-relaxed break-all text-muted-foreground">{conflict?.name}</p>
          <Input
            value={conflictInput}
            onChange={(e) => setConflictInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              if (!conflictInput.trim()) { toast.error('文件名不能为空'); return }
              resolveConflict(conflictInput.trim())
            }}
          />
          <DialogFooter className="sm:flex-wrap">
            <Button variant="outline" onClick={() => resolveConflict(null)}>取消</Button>
            <Button variant="outline" onClick={() => resolveConflict('__auto__')}>加编码继续</Button>
            <Button onClick={() => { if (!conflictInput.trim()) { toast.error('文件名不能为空'); return } resolveConflict(conflictInput.trim()) }}>重命名上传</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!qr} onOpenChange={(o) => { if (!o) setQr(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>扫码访问文件直链</DialogTitle></DialogHeader>
          {qr ? <img src={qr.img} alt="二维码" className="mx-auto size-56 rounded-lg bg-white p-2" /> : null}
          <p className="text-center text-xs break-all text-muted-foreground">{qr?.url}</p>
          <DialogFooter><Button onClick={() => qr && void navigator.clipboard.writeText(qr.url).then(() => toast.success('链接已复制'))}>复制链接</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {drop ? <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-background/82"><div className="rounded-2xl border border-dashed border-foreground/25 bg-popover px-16 py-12 text-center shadow-sm"><div className="text-lg font-semibold">松开即上传</div><div className="mt-1 text-sm text-muted-foreground">文件会按类型放进图片、视频或其他</div></div></div> : null}
      {xfer ? null : <TransferDock />}
    </div>
  )
}

function ArmReset() {
  const selected = useDrive((s) => s.selected)
  useEffect(() => { clearArmedRef.current() }, [selected])
  return null
}

const PreviewBanner = memo(function PreviewBanner() {
  const on = useDrive((s) => s.previewMode)
  if (!on) return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/70 px-4 py-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
      当前是预览，云端列表和上传要等接口可用
    </div>
  )
})

const SideNav = memo(function SideNav({ xfer, side, onClose, onPickDir, onTransfer, onRecent }: {
  xfer: boolean
  side: boolean
  onClose: () => void
  onPickDir: (id: DirId) => void
  onTransfer: () => void
  onRecent: () => void
}) {
  const { theme, setTheme } = useTheme()
  const dir = useDrive((s) => s.dir)
  const recent = useDrive((s) => s.recent)
  const [dropDir, setDropDir] = useState<DirId | null>(null)
  useEffect(() => {
    const end = () => {
      draggingKeys.current = []
      setDropDir(null)
    }
    window.addEventListener('dragend', end)
    return () => window.removeEventListener('dragend', end)
  }, [])
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0e0f11' : '#ffffff')
  }, [theme])
  return (
    <aside className={`${side ? 'flex' : 'hidden'} glass-side absolute inset-y-0 left-0 z-40 w-60 flex-col border-r md:static md:flex`}>
      <div className="flex items-center gap-2.5 px-3.5 py-3.5">
        <div className="grid size-8 place-items-center rounded-lg bg-foreground text-background"><Cloud className="size-4" /></div>
        <div className="min-w-0">
          <div className="text-sm leading-none font-semibold">云窝</div>
          <div className="mt-1 text-[11px] text-muted-foreground">私有网盘</div>
        </div>
      </div>
      <ScrollArea className="flex-1 px-2">
        <p className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">文件</p>
        <div className="space-y-0.5">
          {DIRS.map((d) => (
            <button
              key={d.id}
              type="button"
              className={navClass(!xfer && !recent && dir === d.id, dropDir === d.id)}
              onClick={() => onPickDir(d.id)}
              onDragOver={(e) => {
                if (d.id === 'all' || draggingKeys.current.length === 0) return
                e.preventDefault()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                if (e.currentTarget.dataset.over === '1') return
                e.currentTarget.dataset.over = '1'
                setDropDir(d.id)
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                e.currentTarget.dataset.over = ''
                setDropDir((cur) => cur === d.id ? null : cur)
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.currentTarget.dataset.over = ''
                setDropDir(null)
                const keys = draggingKeys.current
                draggingKeys.current = []
                if (d.id === 'all' || !keys.length) return
                void useDrive.getState().move(keys, d.id)
              }}
            >
              {d.id === 'all' ? <Folder className="size-4" /> : d.id === 'img' ? <ImageIcon className="size-4" /> : d.id === 'video' ? <Film className="size-4" /> : <Box className="size-4" />}
              {d.label}
            </button>
          ))}
        </div>
        <p className="px-2.5 pt-4 pb-1 text-[11px] font-medium text-muted-foreground">传输</p>
        <button type="button" className={navClass(xfer)} onClick={onTransfer}>
          <ArrowDownUp className="size-4" /> 传输
          <QueueBadge />
        </button>
        <p className="px-2.5 pt-4 pb-1 text-[11px] font-medium text-muted-foreground">本地</p>
        <button type="button" className={navClass(recent && !xfer)} onClick={onRecent}>
          <Clock className="size-4" /> 本机最近
        </button>
      </ScrollArea>
      <div className="flex items-center gap-1 border-t p-2">
        <IconTip label={theme === 'dark' ? '浅色' : '深色'}>
          <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="切换主题">
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </IconTip>
        <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => { clearSession(); useDrive.getState().setUnlocked(false); onClose() }}>
          <LogOut /> 退出
        </Button>
      </div>
    </aside>
  )
})

const Crumbs = memo(function Crumbs({ xfer }: { xfer: boolean }) {
  const recent = useDrive((s) => s.recent)
  const dir = useDrive((s) => s.dir)
  return (
    <div className="flex min-w-0 items-center gap-1 text-sm">
      {xfer ? <span className="font-medium">传输</span> : recent ? <span className="font-medium">本机最近</span> : dir === 'all' ? <span className="font-medium">全部文件</span> : (
        <>
          <span className="text-muted-foreground">全部文件</span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{dirLabel(dir)}</span>
        </>
      )}
    </div>
  )
})

const SearchBox = memo(function SearchBox() {
  const query = useDrive((s) => s.query)
  const setQuery = useDrive((s) => s.setQuery)
  return (
    <div className="relative hidden min-w-40 max-w-xs flex-1 sm:block">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选当前目录" className="h-8 border-transparent bg-background/45 pl-8 shadow-none focus-visible:border-ring focus-visible:bg-background" />
    </div>
  )
})

const TopBar = memo(function TopBar({ xfer, armed, ask, onUpload, onOpenSide }: {
  xfer: boolean
  armed: boolean
  ask: (keys: string[], quiet?: boolean) => void
  onUpload: () => void
  onOpenSide: () => void
}) {
  return (
    <header className="glass-bar flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenSide} aria-label="目录"><Rows3 /></Button>
      <Crumbs xfer={xfer} />
      {xfer ? null : <SearchBox />}
      {xfer ? (
        <div className="ml-auto">
          <Button onClick={onUpload}><Upload /> 上传</Button>
        </div>
      ) : (
        <>
          <BrowseTools />
          <SelectionTools armed={armed} ask={ask} />
        </>
      )}
      <input id="file-pick" type="file" multiple hidden onChange={(e) => { enqueue([...(e.target.files || [])]); e.target.value = '' }} />
    </header>
  )
})

type FileHandlers = {
  onClick: (e: ReactMouseEvent, f: CloudFile) => void
  onDouble: (f: CloudFile) => void
  onCheck: (key: string) => void
  onMenu: (e: ReactMouseEvent, f: CloudFile) => void
  onDragStart: (e: ReactDragEvent, f: CloudFile) => void
}

const FileBody = memo(function FileBody({ xfer, onUpload, onClick, onDouble, onCheck, onMenu, onDragStart }: FileHandlers & { xfer: boolean; onUpload: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const recent = useDrive((s) => s.recent)
  const loading = useDrive((s) => s.loading)
  const view = useDrive((s) => s.view)
  const files = useDrive((s) => s.files)
  const query = useDrive((s) => s.query)
  const sort = useDrive((s) => s.sort)
  const hint = useDrive((s) => s.hint)
  const dir = useDrive((s) => s.dir)
  const truncated = useDrive((s) => s.truncated)
  const load = useDrive((s) => s.load)
  const shownView = useDeferredValue(view)
  const shownSort = useDeferredValue(sort)
  const shownQuery = useDeferredValue(query)
  const sorted = useMemo(() => sortFiles(files, shownSort), [files, shownSort])
  const visible = useMemo(() => filterFiles(sorted, shownQuery), [sorted, shownQuery])
  const scrollKey = `${shownView}|${shownSort}|${shownQuery}|${dir}`
  const handlers = useMemo<FileHandlers>(() => ({ onClick, onDouble, onCheck, onMenu, onDragStart }), [onClick, onDouble, onCheck, onMenu, onDragStart])

  useEffect(() => {
    if (!xfer && !recent) visibleRef.current = visible
  }, [visible, xfer, recent])
  useEffect(() => {
    const sample = files.find((f) => fileMeta(f).type === 'image')
    if (!sample) return
    let origin = ''
    try { origin = new URL(sample.url).origin } catch { return }
    if (document.head.querySelector(`link[data-yunwo="${origin}"]`)) return
    const link = document.createElement('link')
    link.rel = 'preconnect'
    link.href = origin
    link.crossOrigin = 'anonymous'
    link.dataset.yunwo = origin
    document.head.appendChild(link)
  }, [files])

  if (xfer) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="file-scroll min-h-0 flex-1"><TransferPage /></div>
        <QueueFooter />
      </div>
    )
  }
  if (recent) return <div className="file-scroll min-h-0 flex-1"><Recent /></div>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="file-scroll min-h-0 flex-1"
        onMouseDown={(e) => {
          if (e.button !== 0) return
          const t = e.target as HTMLElement
          if (t.closest('[data-file],[data-stop],button,a,input,label')) return
          useDrive.getState().clearSel()
        }}
      >
        {loading ? <SkeletonRows /> : !visible.length ? (
          <EmptyState filtered={!!shownQuery.trim()} query={shownQuery.trim()} hint={hint} onUpload={onUpload} />
        ) : shownView === 'list' ? (
          <ListFiles files={visible} scrollRef={scrollRef} scrollKey={scrollKey} handlers={handlers} />
        ) : shownView === 'grid' ? (
          <GridFiles files={visible} scrollRef={scrollRef} scrollKey={scrollKey} handlers={handlers} />
        ) : (
          <FallFiles files={visible} scrollRef={scrollRef} scrollKey={scrollKey} handlers={handlers} />
        )}
      </div>
      <footer className="glass-bar flex h-9 shrink-0 items-center gap-3 border-t px-4 text-xs text-muted-foreground">
        <span className="tabular-nums">{shownQuery.trim() ? `筛选出 ${visible.length} / 共 ${files.length}` : `${files.length} 个文件`}</span>
        {hint && files.length ? <span className="truncate text-amber-700 dark:text-amber-300">{hint}</span> : null}
        {truncated ? <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void load(true)}>加载更多</Button> : null}
      </footer>
    </div>
  )
})

function SkeletonRows() {
  return (
    <div className="px-3 py-2">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-12 items-center gap-3">
          <div className="size-4 animate-pulse rounded bg-muted" />
          <div className="size-9 animate-pulse rounded-md bg-muted" />
          <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${36 + (i % 4) * 10}%` }} />
        </div>
      ))}
    </div>
  )
}

function EmptyState({ filtered, query, hint, onUpload }: { filtered: boolean; query: string; hint: string; onUpload: () => void }) {
  return (
    <div className="grid min-h-[52vh] place-items-center px-6">
      <div className="max-w-xs text-center">
        <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
          {filtered ? <Search className="size-5" /> : <Folder className="size-5" />}
        </div>
        <div className="text-sm font-medium">{filtered ? '没有匹配的文件' : hint ? '暂时看不到云端文件' : '这个文件夹是空的'}</div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {filtered ? `没有名称包含「${query}」的文件` : hint || '把文件拖进窗口，或从右上角上传'}
        </p>
        {!filtered && !hint ? <Button className="mt-4" data-stop onClick={onUpload}><Upload /> 上传</Button> : null}
      </div>
    </div>
  )
}

const LIST_COLS = 'grid grid-cols-[36px_44px_minmax(0,1fr)_32px] items-center sm:grid-cols-[36px_44px_minmax(0,1fr)_88px_32px] lg:grid-cols-[36px_44px_minmax(0,1fr)_88px_148px_32px]'

const ListFiles = memo(function ListFiles({ files, scrollRef, scrollKey, handlers }: {
  files: CloudFile[]
  scrollRef: RefObject<HTMLDivElement | null>
  scrollKey: string
  handlers: FileHandlers
}) {
  const rowH = useListRowH()
  const headRef = useRef<HTMLDivElement>(null)
  const virtual = files.length > 36
  const [range, setRange] = useState({ start: 0, end: 28 })
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
  }, [scrollKey, scrollRef])
  useLayoutEffect(() => {
    if (!virtual) return
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const measure = () => {
      const head = headRef.current?.offsetHeight ?? 0
      const top = el.scrollTop
      const view = el.clientHeight || 640
      const start = Math.max(0, Math.floor((top - head) / rowH) - 8)
      const end = Math.min(files.length, Math.ceil((top - head + view) / rowH) + 8)
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; measure() })
    }
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [virtual, scrollKey, scrollRef, files.length, rowH])
  const start = virtual ? range.start : 0
  const end = virtual ? range.end : files.length
  const slice = virtual ? files.slice(start, end) : files
  return (
    <div className="min-w-0 px-1" style={{ ['--row-h' as string]: `${rowH}px` }}>
      <div ref={headRef} className={`${LIST_COLS} sticky top-0 z-10 border-b bg-background px-2 text-[11px] text-muted-foreground`}>
        <span /><span /><span className="py-2">名称</span>
        <span className="hidden py-2 text-right sm:block">大小</span>
        <span className="hidden py-2 text-right lg:block">修改时间</span>
        <span />
      </div>
      {virtual ? (
        <div style={{ height: files.length * rowH, position: 'relative' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translate3d(0,${start * rowH}px,0)` }}>
            {slice.map((f) => <FileRow key={f.key} file={f} measured handlers={handlers} />)}
          </div>
        </div>
      ) : slice.map((f) => <FileRow key={f.key} file={f} handlers={handlers} />)}
    </div>
  )
})

const GridFiles = memo(function GridFiles({ files, scrollRef, scrollKey, handlers }: {
  files: CloudFile[]
  scrollRef: RefObject<HTMLDivElement | null>
  scrollKey: string
  handlers: FileHandlers
}) {
  const virtual = files.length > 30
  const [layout, setLayout] = useState(() => gridLayout(typeof window === 'undefined' ? 960 : window.innerWidth))
  const [range, setRange] = useState({ start: 0, end: 4 })
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
  }, [scrollKey, scrollRef])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const measure = () => {
      const next = gridLayout(el.clientWidth)
      setLayout((prev) => (prev.cols === next.cols && Math.abs(prev.rowH - next.rowH) < 0.5 ? prev : next))
      if (!virtual) return
      const rowCount = Math.ceil(files.length / next.cols)
      const pad = 16
      const top = el.scrollTop
      const view = el.clientHeight || 640
      const start = Math.max(0, Math.floor((top - pad) / next.rowH) - 2)
      const end = Math.min(rowCount, Math.ceil((top - pad + view) / next.rowH) + 2)
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    const onScroll = () => {
      if (!virtual || raf) return
      raf = requestAnimationFrame(() => { raf = 0; measure() })
    }
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [virtual, scrollKey, scrollRef, files.length])
  if (!virtual) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 p-4">
        {files.map((f) => <FileCard key={f.key} file={f} fall={false} handlers={handlers} />)}
      </div>
    )
  }
  const rowCount = Math.ceil(files.length / layout.cols)
  const start = Math.min(range.start, Math.max(0, rowCount - 1))
  const end = Math.max(start + 1, Math.min(rowCount, range.end))
  const slice = files.slice(start * layout.cols, end * layout.cols)
  const pad = 16
  return (
    <div style={{ boxSizing: 'border-box', height: rowCount * layout.rowH + pad * 2, padding: pad }}>
      <div style={{ position: 'relative', height: rowCount * layout.rowH }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translate3d(0,${start * layout.rowH}px,0)`,
            display: 'grid',
            gridTemplateColumns: `repeat(${layout.cols},minmax(0,1fr))`,
            gap: 12,
          }}
        >
          {slice.map((f) => <FileCard key={f.key} file={f} fall={false} measured handlers={handlers} />)}
        </div>
      </div>
    </div>
  )
})

const FallFiles = memo(function FallFiles({ files, scrollRef, scrollKey, handlers }: {
  files: CloudFile[]
  scrollRef: RefObject<HTMLDivElement | null>
  scrollKey: string
  handlers: FileHandlers
}) {
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
  }, [scrollKey, scrollRef])
  return (
    <div className="columns-[210px] gap-3 p-4">
      {files.map((f) => <FileCard key={f.key} file={f} fall handlers={handlers} />)}
    </div>
  )
})

function RowCheck({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      data-stop
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      className={`relative grid size-4 place-items-center rounded-[4px] border after:absolute after:-inset-x-3 after:-inset-y-2 ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background dark:bg-input/30'}`}
    >
      {on ? <CheckIcon className="size-3.5" /> : null}
    </button>
  )
}

const FileRow = memo(function FileRow({ file, measured, handlers }: { file: CloudFile; measured?: boolean; handlers: FileHandlers }) {
  const on = useDrive(pickedSelector(file.key))
  const meta = fileMeta(file)
  return (
    <div
      data-file
      draggable
      onDragStart={(e) => handlers.onDragStart(e, file)}
      onClick={(e) => handlers.onClick(e, file)}
      onDoubleClick={() => handlers.onDouble(file)}
      onContextMenu={(e) => handlers.onMenu(e, file)}
      className={`${LIST_COLS} file-row ${measured ? 'is-measured' : ''} group border-b border-border/70 px-2 text-sm select-none ${on ? 'file-selected' : 'hover:bg-muted/70'}`}
    >
      <RowCheck on={on} onToggle={() => handlers.onCheck(file.key)} />
      <Thumb file={file} />
      <div className="min-w-0 pr-3" title={meta.name}>
        <div className="truncate">{meta.name}</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground sm:hidden">{meta.sizeLabel} · {meta.timeLabel}</div>
      </div>
      <div className="hidden text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:block">{meta.sizeLabel}</div>
      <div className="hidden text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:block">{meta.timeLabel}</div>
      <Button data-stop variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={(e) => { e.stopPropagation(); handlers.onMenu(e, file) }} aria-label="更多"><MoreHorizontal /></Button>
    </div>
  )
})

const FileCard = memo(function FileCard({ file, fall, measured, handlers }: { file: CloudFile; fall: boolean; measured?: boolean; handlers: FileHandlers }) {
  const on = useDrive(pickedSelector(file.key))
  const meta = fileMeta(file)
  return (
    <div
      data-file
      draggable
      onDragStart={(e) => handlers.onDragStart(e, file)}
      onClick={(e) => handlers.onClick(e, file)}
      onDoubleClick={() => handlers.onDouble(file)}
      onContextMenu={(e) => handlers.onMenu(e, file)}
      className={`file-card ${measured ? 'is-measured' : ''} ${fall ? 'is-fall' : ''} group relative rounded-xl select-none ${on ? 'ring-2 ring-[oklch(0.58_0.16_255)]' : ''} ${fall ? 'mb-3 break-inside-avoid' : ''}`}
    >
      <div className={`relative overflow-hidden rounded-xl border bg-muted/30 ${on ? 'border-transparent' : ''} ${fall ? '' : 'aspect-square'}`}>
        <Thumb file={file} mode={fall ? 'natural' : 'cover'} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-2.5 pt-8 text-xs text-white">
          <div className="truncate">{meta.name}</div>
          <div className="mt-0.5 opacity-70 tabular-nums">{meta.sizeLabel}</div>
        </div>
        <div className={`absolute top-2 left-2 rounded-md bg-background/95 p-0.5 shadow-sm ${on ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100'}`} data-stop>
          <RowCheck on={on} onToggle={() => handlers.onCheck(file.key)} />
        </div>
      </div>
    </div>
  )
})

function frameSrc(url: string) {
  return url.includes('#') ? url : `${url}#t=0.1`
}

function rememberPoster(url: string, video: HTMLVideoElement) {
  if (videoPosters.has(url) || !video.videoWidth) return false
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 135
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const poster = canvas.toDataURL('image/jpeg', 0.72)
    videoPosters.set(url, poster)
    return true
  } catch {
    return false
  }
}

function VideoFrame({ url, className }: { url: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [on, setOn] = useState(false)
  const [failed, setFailed] = useState(false)
  const [poster, setPoster] = useState(() => videoPosters.get(url) || '')
  const released = useRef(false)
  const live = useRef(true)
  const finish = (video?: HTMLVideoElement) => {
    if (!live.current || released.current) return
    released.current = true
    if (video && rememberPoster(url, video)) setPoster(videoPosters.get(url) || '')
    const el = ref.current
    if (el) releaseVideoLoad(el)
  }
  useEffect(() => {
    live.current = true
    if (videoPosters.has(url)) return () => { live.current = false }
    const el = ref.current
    if (!el) return () => { live.current = false }
    released.current = false
    const stop = watchVideo(el, setOn)
    return () => { live.current = false; stop() }
  }, [url])
  const showVideo = on && !failed && !poster
  return (
    <div ref={ref} className={className}>
      <div className="relative h-full w-full overflow-hidden bg-muted">
        {poster ? (
          <img src={poster} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
        ) : showVideo ? (
          <video
            muted
            playsInline
            preload="metadata"
            disablePictureInPicture
            src={frameSrc(url)}
            className="pointer-events-none absolute inset-0 h-full w-full bg-black object-cover"
            onLoadedData={(e) => finish(e.currentTarget)}
            onError={() => { setFailed(true); finish() }}
          />
        ) : (
          <div className="grid h-full min-h-9 w-full place-items-center"><Film className="size-4 text-muted-foreground" /></div>
        )}
      </div>
    </div>
  )
}

const SmartImg = memo(function SmartImg({ src, px, ext, mode = 'fill', className }: {
  src: string
  px: number
  ext: string
  mode?: 'fill' | 'fit'
  className: string
}) {
  const [rev, setRev] = useState(0)
  const [failedSrc, setFailedSrc] = useState('')
  useEffect(() => {
    const sync = () => setRev((n) => n + 1)
    thumbListeners.add(sync)
    return () => { thumbListeners.delete(sync) }
  }, [])
  const desired = thumbAllowed() ? thumbUrl(src, px, ext, mode) : src
  const cur = failedSrc === desired ? src : desired
  return (
    <img
      key={rev}
      src={cur}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      className={className}
      onError={() => {
        if (!cur.includes('x-oss-process=')) return
        setFailedSrc(cur)
        if (thumbMode === 'off' || thumbProbe) return
        thumbProbe = true
        disableThumbs()
        const probe = new Image()
        probe.onload = () => { thumbProbe = false }
        probe.onerror = () => {
          thumbProbe = false
          thumbMode = 'try'
          thumbListeners.forEach((fn) => fn())
        }
        probe.src = src
      }}
    />
  )
})

const Thumb = memo(function Thumb({ file, mode = 'cell' }: { file: CloudFile; mode?: 'cell' | 'cover' | 'natural' }) {
  const meta = fileMeta(file)
  if (meta.type === 'image' && mode === 'natural') {
    return <SmartImg src={file.url} px={480} ext={meta.ext} mode="fit" className="block h-auto w-full" />
  }
  if (meta.type === 'image') {
    if (mode === 'cell') {
      return (
        <div className="size-9 overflow-hidden rounded-md bg-muted">
          <SmartImg src={file.url} px={96} ext={meta.ext} className="size-9 object-cover" />
        </div>
      )
    }
    return <SmartImg src={file.url} px={mode === 'natural' ? 480 : 360} ext={meta.ext} mode={mode === 'natural' ? 'fit' : 'fill'} className={mode === 'natural' ? 'block h-auto w-full' : 'absolute inset-0 h-full w-full object-cover'} />
  }
  if (meta.type === 'video') {
    if (mode === 'cell') return <VideoFrame url={file.url} className="size-9 overflow-hidden rounded-md" />
    if (mode === 'natural') return <VideoFrame url={file.url} className="aspect-video max-h-[420px] w-full" />
    return <VideoFrame url={file.url} className="absolute inset-0 h-full w-full" />
  }
  const box = mode === 'cell' ? 'grid size-9 place-items-center overflow-hidden rounded-md bg-muted' : mode === 'natural' ? 'grid aspect-[4/3] w-full place-items-center bg-muted' : 'absolute inset-0 grid place-items-center bg-muted'
  return <div className={`${box} text-[10px] font-medium text-muted-foreground`}>{(meta.ext || 'file').slice(0, 4).toUpperCase()}</div>
})

const DeskInspector = memo(function DeskInspector({ xfer, onQr, onRename, onDelete }: {
  xfer: boolean
  onQr: (url: string) => void
  onRename: (file: CloudFile) => void
  onDelete: (key: string) => void
}) {
  const narrow = useNarrow()
  const recent = useDrive((s) => s.recent)
  const fmt = useDrive((s) => s.fmt)
  const file = useDrive(oneFile)
  if (narrow || xfer || recent || !file) return null
  return (
    <Inspector
      file={file}
      fmt={fmt}
      onFmt={(f) => { useDrive.getState().setFmt(f); void copyFiles([file], f) }}
      onOpen={() => openFile(file)}
      onDown={() => downloadFile(file)}
      onQr={() => onQr(file.url)}
      onRename={() => onRename(file)}
      onDelete={() => onDelete(file.key)}
      onMove={(d) => void useDrive.getState().move([file.key], d)}
    />
  )
})

function Inspector(props: { file: CloudFile } & InspectorActions) {
  return (
    <aside className="glass-side hidden w-80 shrink-0 flex-col overflow-auto border-l lg:flex">
      <div className="px-4 py-3 text-[11px] font-medium text-muted-foreground">详细信息</div>
      <InspectorBody {...props} />
    </aside>
  )
}
type InspectorActions = {
  fmt: LinkFmt
  onFmt: (f: LinkFmt) => void
  onOpen: () => void
  onDown: () => void
  onQr: () => void
  onRename: () => void
  onDelete: () => void
  onMove: (d: Exclude<DirId, 'all'>) => void
}
function InspectorMedia({ file }: { file: CloudFile }) {
  const meta = fileMeta(file)
  const [shownKey, setShownKey] = useState(file.key)
  const [ready, setReady] = useState(false)
  if (shownKey !== file.key) {
    setShownKey(file.key)
    setReady(false)
  }
  useEffect(() => {
    let live = true
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => { if (live) setReady(true) })
    })
    return () => { live = false; cancelAnimationFrame(id) }
  }, [file.key])
  if (!ready) return <div className="h-full w-full" />
  if (meta.type === 'image') return <SmartImg src={file.url} px={480} ext={meta.ext} mode="fit" className="max-h-40 w-full object-contain" />
  if (meta.type === 'video') return <VideoFrame url={file.url} className="h-full max-h-40 w-full" />
  return <span className="text-sm text-muted-foreground">文件</span>
}
function InspectorBody({ file, fmt, onFmt, onOpen, onDown, onQr, onRename, onDelete, onMove }: { file: CloudFile } & InspectorActions) {
  const meta = fileMeta(file)
  const kind = meta.type === 'image' ? '图片' : meta.type === 'video' ? '视频' : '文件'
  return (
    <div className="space-y-4 px-4 pb-6">
      <div className="grid h-40 place-items-center overflow-hidden rounded-xl bg-muted">
        <InspectorMedia file={file} />
      </div>
      <div className="text-sm leading-snug font-medium break-all">{meta.name}</div>
      <dl className="text-xs">
        {([
          ['大小', meta.sizeLabel],
          ['类型', kind],
          ['修改时间', meta.timeLabel],
          ['位置', dirLabel(dirOf(file.key))],
        ] as const).map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2 last:border-0">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="rounded-lg bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed break-all text-muted-foreground">{file.key}</p>
      <div className="flex flex-wrap gap-1">
        {(['url', 'md', 'html', 'bbcode'] as LinkFmt[]).map((f) => <Button key={f} size="xs" variant={fmt === f ? 'default' : 'outline'} onClick={() => onFmt(f)}>{f.toUpperCase()}</Button>)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button className="col-span-2" onClick={onOpen}>打开</Button>
        <Button variant="outline" onClick={onDown}>下载</Button>
        <Button variant="outline" onClick={onQr}>二维码</Button>
        <Button variant="outline" onClick={onRename}>重命名</Button>
        <Button variant="destructive" onClick={onDelete}>删除</Button>
      </div>
      <div className="text-xs text-muted-foreground">移动到</div>
      <div className="flex gap-2">
        {(['img', 'video', 'other'] as const).map((d) => <Button key={d} size="sm" variant="outline" disabled={dirOf(file.key) === d} onClick={() => onMove(d)}>{dirLabel(d)}</Button>)}
      </div>
    </div>
  )
}

const MobileDetails = memo(function MobileDetails({ xfer, sheet, setSheet, onQr, onRename, onDelete }: {
  xfer: boolean
  sheet: boolean
  setSheet: (v: boolean) => void
  onQr: (url: string) => void
  onRename: (file: CloudFile) => void
  onDelete: (key: string) => void
}) {
  const narrow = useNarrow()
  const recent = useDrive((s) => s.recent)
  const fmt = useDrive((s) => s.fmt)
  const file = useDrive(oneFile)
  const open = !!(narrow && sheet && file && !xfer && !recent)
  return (
    <Sheet open={open} onOpenChange={setSheet}>
      <SheetContent side="bottom" className="max-h-[80svh] overflow-auto bg-popover">
        <SheetHeader><SheetTitle>详细信息</SheetTitle></SheetHeader>
        {file ? (
          <InspectorBody
            file={file}
            fmt={fmt}
            onFmt={(f) => { useDrive.getState().setFmt(f); void copyFiles([file], f) }}
            onOpen={() => openFile(file)}
            onDown={() => downloadFile(file)}
            onQr={() => onQr(file.url)}
            onRename={() => onRename(file)}
            onDelete={() => onDelete(file.key)}
            onMove={(d) => void useDrive.getState().move([file.key], d)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
})

function ContextMenu({ menu, onClose, onQr, onDelete }: {
  menu: { x: number; y: number; file: CloudFile }
  onClose: () => void
  onQr: (url: string) => void
  onDelete: (keys: string[], quiet?: boolean) => void
}) {
  return (
    <div className="fixed z-50 min-w-44 origin-top-left rounded-xl border bg-popover p-1 text-sm shadow-lg" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 320) }}>
      <MenuBtn onClick={() => { openFile(menu.file); onClose() }}>打开</MenuBtn>
      {(['url', 'md', 'html', 'bbcode'] as LinkFmt[]).map((f) => (
        <MenuBtn key={f} onClick={() => { const st = useDrive.getState(); st.setFmt(f); void copyFiles(pickedFiles(menu.file), f); onClose() }}>复制 {f.toUpperCase()}</MenuBtn>
      ))}
      <MenuBtn onClick={() => { downloadFile(menu.file); onClose() }}>下载</MenuBtn>
      <MenuBtn onClick={() => { void onQr(menu.file.url); onClose() }}>二维码</MenuBtn>
      <MenuBtn onClick={() => { useDrive.getState().setRenameFor(menu.file); onClose() }}>重命名</MenuBtn>
      <div className="my-1 h-px bg-border" />
      <div className="px-2 py-1 text-[11px] text-muted-foreground">移动到</div>
      {(['img', 'video', 'other'] as const).map((d) => (
        <MenuBtn key={d} disabled={dirOf(menu.file.key) === d} onClick={() => { const st = useDrive.getState(); void st.move(isPicked(st.selected, menu.file.key) ? st.selected : [menu.file.key], d); onClose() }}>{dirLabel(d)}</MenuBtn>
      ))}
      <MenuBtn className="text-destructive" onClick={() => { const st = useDrive.getState(); const keys = isPicked(st.selected, menu.file.key) ? st.selected : [menu.file.key]; onClose(); onDelete(keys) }}>删除</MenuBtn>
    </div>
  )
}

function MenuBtn({ children, onClick, disabled, className = '' }: { children: ReactNode; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={`flex h-8 w-full items-center rounded-md px-2 text-left hover:bg-muted disabled:opacity-40 ${className}`}>{children}</button>
}

function FullImg({ src, ext, className }: { src: string; ext: string; className: string }) {
  const preview = thumbAllowed() ? thumbUrl(src, 960, ext, 'fit') : src
  const [fullFor, setFullFor] = useState('')
  const cur = fullFor === src ? src : preview
  useEffect(() => {
    if (preview === src) return
    let live = true
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => { if (live) setFullFor(src) }
    img.onerror = () => { if (live) setFullFor(src) }
    img.src = src
    return () => { live = false }
  }, [src, preview])
  return <img src={cur} alt="" decoding="async" className={className} onError={() => { if (cur !== src) setFullFor(src) }} />
}

function Preview({ file }: { file: CloudFile }) {
  const meta = fileMeta(file)
  if (meta.type === 'image') return <div className="grid max-h-[68vh] place-items-center overflow-hidden rounded-lg bg-muted"><FullImg src={file.url} ext={meta.ext} className="max-h-[68vh] w-full object-contain" /></div>
  if (meta.type === 'video') return <video src={file.url} controls playsInline className="max-h-[68vh] w-full rounded-lg bg-black" />
  return <div className="grid place-items-center rounded-lg border bg-muted/40 py-16 text-sm">{meta.name}</div>
}

const LightDialog = memo(function LightDialog() {
  const light = useDrive((s) => s.light)
  const openLight = useDrive((s) => s.openLight)
  return (
    <Dialog open={!!light} onOpenChange={(o) => { if (!o) openLight(null) }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader><DialogTitle className="truncate">{light ? fileMeta(light).name : ''}</DialogTitle></DialogHeader>
        {light ? <Preview file={light} /> : null}
        <p className="text-xs leading-relaxed break-all text-muted-foreground">{light ? `${light.key} · ${fileMeta(light).sizeLabel} · ${fileMeta(light).timeLabel}` : ''}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => stepLight(-1)}>上一个</Button>
          <Button variant="outline" onClick={() => stepLight(1)}>下一个</Button>
          {light ? <Button onClick={() => void copyFiles([light])}>复制链接</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

const RenameDialog = memo(function RenameDialog() {
  const file = useDrive((s) => s.renameFor)
  const [draft, setDraft] = useState<{ key: string; name: string } | null>(null)
  const name = file ? (draft?.key === file.key ? draft.name : fileNameOf(file.key)) : ''
  const setName = (next: string) => { if (file) setDraft({ key: file.key, name: next }) }
  return (
    <Dialog open={!!file} onOpenChange={(o) => { if (!o) useDrive.getState().setRenameFor(null) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>重命名</DialogTitle></DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && file) void useDrive.getState().rename(file.key, name.trim()) }} />
        <DialogFooter>
          <Button variant="outline" onClick={() => useDrive.getState().setRenameFor(null)}>取消</Button>
          <Button onClick={() => file && void useDrive.getState().rename(file.key, name.trim())}>确定</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

const BrowseTools = memo(function BrowseTools() {
  const sort = useDrive((st) => st.sort)
  const view = useDrive((st) => st.view)
  const loading = useDrive((st) => st.loading)
  const count = useDrive((st) => st.selected.length)
  const [settings, setSettings] = useState(false)
  const [keep, setKeep] = useState(() => localStorage.getItem('yunwo_keepname') !== '0')
  const [webp, setWebp] = useState(() => localStorage.getItem('yunwo_webp') === '1')
  const [quality, setQuality] = useState(() => Number(localStorage.getItem('yunwo_quality') || '82'))
  return (
    <div className={count === 0 ? 'ml-auto flex flex-wrap items-center gap-1.5' : 'hidden'}>
      <Select value={sort} onValueChange={(v) => useDrive.getState().setSort(v as typeof sort)}>
        <SelectTrigger className="h-8 w-[118px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="time_desc">最新上传</SelectItem>
          <SelectItem value="time_asc">最早上传</SelectItem>
          <SelectItem value="size_desc">文件最大</SelectItem>
          <SelectItem value="size_asc">文件最小</SelectItem>
          <SelectItem value="name_asc">名称 A-Z</SelectItem>
          <SelectItem value="name_desc">名称 Z-A</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex rounded-lg bg-background/40 p-0.5">
        <IconTip label="列表"><Button variant={view === 'list' ? 'secondary' : 'ghost'} size="icon-sm" onClick={() => useDrive.getState().setView('list')} aria-label="列表" aria-pressed={view === 'list'}><Rows3 /></Button></IconTip>
        <IconTip label="平铺"><Button variant={view === 'grid' ? 'secondary' : 'ghost'} size="icon-sm" onClick={() => useDrive.getState().setView('grid')} aria-label="平铺" aria-pressed={view === 'grid'}><LayoutGrid /></Button></IconTip>
        <IconTip label="瀑布流"><Button variant={view === 'fall' ? 'secondary' : 'ghost'} size="icon-sm" onClick={() => useDrive.getState().setView('fall')} aria-label="瀑布流" aria-pressed={view === 'fall'}><Columns2 /></Button></IconTip>
      </div>
      <IconTip label="刷新">
        <Button variant="ghost" size="icon" onClick={() => void useDrive.getState().load(false)} aria-label="刷新"><RefreshCw className={loading ? 'animate-spin' : ''} /></Button>
      </IconTip>
      <DropdownMenu open={settings} onOpenChange={setSettings}>
        <div className="flex">
          <Button className="rounded-r-none" onClick={() => document.getElementById('file-pick')?.click()}><Upload /> 上传</Button>
          <DropdownMenuTrigger asChild>
            <Button className="w-8 rounded-l-none border-l border-primary-foreground/15 px-0" aria-label="上传设置"><ChevronDown /></Button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align="end" className="w-72 p-3">
          <div className="mb-2 text-xs font-medium">上传设置</div>
          <label className="flex items-center justify-between gap-3 py-1 text-sm">保留原文件名 <Toggle checked={keep} onCheckedChange={(v) => { setKeep(!!v); localStorage.setItem('yunwo_keepname', v ? '1' : '0') }} /></label>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">同名时会提示重命名，或自动加编码继续</p>
          <label className="mt-3 flex items-center justify-between gap-3 py-1 text-sm">图片压缩为 WebP <Toggle checked={webp} onCheckedChange={(v) => { setWebp(!!v); localStorage.setItem('yunwo_webp', v ? '1' : '0') }} /></label>
          {webp ? <div className="mt-3"><div className="mb-2 text-xs text-muted-foreground">画质 {quality}%</div><Slider value={[quality]} min={10} max={100} onValueChange={(v) => { const n = v[0] ?? 82; setQuality(n); localStorage.setItem('yunwo_quality', String(n)) }} /></div> : null}
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">单文件最大 {getMaxSizeMB()} MB · 大文件分片，可断点续传</p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

const SelectionTools = memo(function SelectionTools({ armed, ask }: { armed: boolean; ask: (keys: string[], quiet?: boolean) => void }) {
  const count = useDrive((st) => st.selected.length)
  return (
    <div className={count > 0 ? 'ml-auto flex flex-wrap items-center gap-1.5' : 'hidden'}>
      <span className="text-xs text-muted-foreground tabular-nums">已选 {count} 项</span>
      <Button size="sm" variant="outline" onClick={() => useDrive.getState().selectAll(visibleRef.current.map((f) => f.key))}>全选</Button>
      <Button size="sm" variant="outline" onClick={() => useDrive.getState().invert(visibleRef.current.map((f) => f.key))}>反选</Button>
      <Button size="sm" variant="outline" onClick={() => { const st = useDrive.getState(); const want = new Set(st.selected); void copyFiles(st.files.filter((f) => want.has(f.key))) }}>复制链接</Button>
      <Button size="sm" variant="destructive" onClick={() => ask(useDrive.getState().selected, true)}>{armed ? `再点确认删除 ${count} 个` : '删除'}</Button>
      <Button size="sm" variant="ghost" onClick={() => { clearArmedRef.current(); useDrive.getState().clearSel() }}>取消</Button>
    </div>
  )
})

const Recent = memo(function Recent() {
  const tick = useDrive((s) => s.histTick)
  const wipe = useDrive((s) => s.wipeHistory)
  const fmt = useDrive((s) => s.fmt)
  const items = tick >= 0 ? useDrive.getState().history() : []
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>只保存在这台浏览器，不同步</span>
        <Button size="sm" variant="outline" onClick={wipe}>清空</Button>
      </div>
      {!items.length ? (
        <div className="grid min-h-[40vh] place-items-center text-center">
          <div>
            <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground"><Clock className="size-5" /></div>
            <div className="text-sm font-medium">还没有上传记录</div>
            <p className="mt-1.5 text-xs text-muted-foreground">记录只留在这台浏览器</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3">
          {items.map((it) => {
            const kind = fileTypeOf(it.url)
            const ext = (it.url.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase()
            return (
              <button key={it.url + it.t} type="button" className="file-card overflow-hidden rounded-xl border bg-card text-left hover:border-foreground/20" onClick={() => navigator.clipboard.writeText(formatLink({ key: it.url, url: it.url, type: kind }, fmt)).then(() => toast.success('已复制'))}>
                {kind === 'image' ? <SmartImg src={it.url} px={320} ext={ext} className="aspect-square w-full object-cover" /> : kind === 'video' ? <VideoFrame url={it.url} className="aspect-square w-full" /> : <div className="grid aspect-square place-items-center bg-muted text-xs text-muted-foreground">文件</div>}
                <div className="truncate px-2 py-1.5 text-xs">{fileNameOf(it.url)}</div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})

function QueueBadge() {
  const items = useQueue()
  const summary = queueSummary()
  const running = summary.count - summary.done - summary.fail
  if (running > 0) return <span className="ml-auto rounded-full bg-foreground px-1.5 text-[10px] font-medium text-background tabular-nums">{running}</span>
  if (items.length > 0) return <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{summary.count}</span>
  return null
}

function QueueFooter() {
  const items = useQueue()
  const summary = queueSummary()
  return (
    <footer className="glass-bar flex h-9 shrink-0 items-center gap-3 border-t px-4 text-xs text-muted-foreground">
      <span className="tabular-nums">{items.length ? summary.title : '没有传输任务'}</span>
    </footer>
  )
}

function TransferPage() {
  const items = useQueue()
  const summary = queueSummary()
  const running = summary.count - summary.done - summary.fail
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      {!items.length ? (
        <div className="grid min-h-[40vh] place-items-center text-center">
          <div>
            <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground"><ArrowDownUp className="size-5" /></div>
            <div className="text-sm font-medium">没有传输任务</div>
            <p className="mt-1.5 text-xs text-muted-foreground">上传的文件会列在这里，可以暂停、继续或取消</p>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <QueueStat label="进行中" value={running} />
            <QueueStat label="已完成" value={summary.done} />
            <QueueStat label="失败" value={summary.fail} />
          </div>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{summary.title}</div>
                <ThinBar value={summary.agg} className="mt-2" tone={summary.fail && !summary.active ? 'err' : 'run'} />
              </div>
              {!summary.active ? <Button size="sm" variant="outline" className="shrink-0" onClick={clearFinished}>清空已结束</Button> : null}
            </div>
            <div>
              {items.map((it) => <TaskRow key={it.id} item={it} name={it.file.name} pct={it.pct} text={it.text} state={it.state} />)}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function QueueStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function ThinBar({ value, tone, className = '' }: { value: number; tone: 'run' | 'ok' | 'err' | 'wait'; className?: string }) {
  const fill = tone === 'ok' ? 'bg-emerald-500' : tone === 'err' ? 'bg-destructive' : tone === 'wait' ? 'bg-foreground/25' : 'bg-foreground/80'
  return (
    <div className={`h-1 overflow-hidden rounded-full bg-muted ${className}`}>
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

function taskTone(state: QueueItem['state']): 'run' | 'ok' | 'err' | 'wait' {
  if (state === 'done') return 'ok'
  if (state === 'err') return 'err'
  if (state === 'queued' || state === 'paused') return 'wait'
  return 'run'
}

function taskLabel(state: QueueItem['state']) {
  if (state === 'done') return '已完成'
  if (state === 'err') return '失败'
  if (state === 'paused') return '已暂停'
  if (state === 'queued') return '排队'
  return '上传中'
}

function TaskIcon({ name }: { name: string }) {
  const t = fileTypeOf(name)
  const icon = t === 'image' ? <ImageIcon className="size-4" /> : t === 'video' ? <Film className="size-4" /> : <FileIcon className="size-4" />
  return <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">{icon}</div>
}

function TaskActions({ item: it }: { item: QueueItem }) {
  if (it.state === 'uploading') {
    return (
      <>
        <Button size="icon-sm" variant="outline" aria-label="暂停" onClick={() => pauseItem(it)}><Pause /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="取消" onClick={() => void cancelItem(it)}><X /></Button>
      </>
    )
  }
  if (it.state === 'paused') {
    return (
      <>
        <Button size="icon-sm" aria-label="继续" onClick={() => resumeItem(it)}><Play /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="取消" onClick={() => void cancelItem(it)}><X /></Button>
      </>
    )
  }
  if (it.state === 'queued') return <Button size="icon-sm" variant="ghost" aria-label="取消" onClick={() => void cancelItem(it)}><X /></Button>
  return <Button size="icon-sm" variant="ghost" aria-label="移除" onClick={() => void cancelItem(it)}><Trash2 /></Button>
}

const TaskRow = memo(function TaskRow({ item, name, pct, text, state, compact = false }: {
  item: QueueItem
  name: string
  pct: number
  text: string
  state: QueueItem['state']
  compact?: boolean
}) {
  const tone = taskTone(state)
  const badgeClass = tone === 'ok' ? 'border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : ''
  return (
    <div className={`flex items-center gap-3 ${compact ? 'rounded-lg bg-muted/40 p-2.5' : 'border-b px-4 py-3 last:border-b-0'}`}>
      {compact ? null : <TaskIcon name={name} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 truncate text-sm font-medium">{name}</div>
          <Badge variant={tone === 'err' ? 'destructive' : 'secondary'} className={`shrink-0 ${badgeClass}`}>{taskLabel(state)}</Badge>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{text}</div>
        <ThinBar value={pct} tone={tone} className="mt-2" />
      </div>
      <div className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{Math.round(pct)}%</div>
      <div className="flex shrink-0 gap-1"><TaskActions item={item} /></div>
    </div>
  )
})

const TransferDock = memo(function TransferDock() {
  const items = useQueue()
  const summary = queueSummary()
  const [folded, setFolded] = useState(false)
  const prev = useRef(0)
  useEffect(() => {
    if (items.length > prev.current) setFolded(false)
    prev.current = items.length
  }, [items.length])
  if (!items.length) return null
  return (
    <div className="fixed right-4 bottom-4 z-40 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-popover shadow-lg ring-1 ring-foreground/10">
      <button type="button" className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm" onClick={() => setFolded(!folded)}>
        <span className="font-medium">{summary.title}</span>
        <span className="text-xs text-muted-foreground">{folded ? '展开' : '收起'}</span>
      </button>
      <ThinBar value={summary.agg} tone={summary.active ? 'run' : summary.fail ? 'err' : 'ok'} />
      {!folded ? (
        <div className="max-h-80 space-y-2 overflow-auto p-2">
          {items.map((it) => <TaskRow key={it.id} item={it} name={it.file.name} pct={it.pct} text={it.text} state={it.state} compact />)}
          {!summary.active ? <Button size="sm" variant="ghost" onClick={clearFinished}>清空已结束</Button> : null}
        </div>
      ) : null}
    </div>
  )
})
