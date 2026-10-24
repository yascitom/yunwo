import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import QRCode from 'qrcode'
import {
  Box, ChevronDown, ChevronRight, Clock, Cloud, Columns2, Film, Folder, Image as ImageIcon, LayoutGrid, LogOut, Moon, MoreHorizontal,
  RefreshCw, Rows3, Search, Sun, Upload,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { Switch as Toggle } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { clearSession } from '@/lib/auth'
import { fileNameOf, fileTypeOf, formatLink, sizeText, fmtTime, dirLabel, dirOf, DIRS, type CloudFile, type DirId, type LinkFmt } from '@/lib/files'
import { cancelItem, clearFinished, enqueue, getMaxSizeMB, getQueue, pauseItem, queueSummary, resumeItem, setConflictAsker, setUploadDone, subscribeQueue, type QueueItem } from '@/lib/upload'
import { useDrive, visibleFiles } from '@/store'

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

function IconTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  )
}

function navClass(active: boolean, over = false) {
  return `flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150 ${active ? 'file-selected font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'} ${over ? 'ring-1 ring-foreground/15' : ''}`
}

export function Drive() {
  const s = useDrive()
  const narrow = useNarrow()
  const { theme, setTheme } = useTheme()
  const queue = useQueue()
  const summary = queueSummary()
  const [menu, setMenu] = useState<{ x: number; y: number; file: CloudFile } | null>(null)
  const [sheet, setSheet] = useState(false)
  const [drop, setDrop] = useState(false)
  const [folded, setFolded] = useState(false)
  const [settings, setSettings] = useState(false)
  const [keep, setKeep] = useState(() => localStorage.getItem('yunwo_keepname') !== '0')
  const [webp, setWebp] = useState(() => localStorage.getItem('yunwo_webp') === '1')
  const [quality, setQuality] = useState(() => Number(localStorage.getItem('yunwo_quality') || '82'))
  const [conflict, setConflict] = useState<{ name: string; resolve: (v: string | null) => void } | null>(null)
  const [conflictInput, setConflictInput] = useState('')
  const [qr, setQr] = useState<{ url: string; img: string } | null>(null)
  const [renameName, setRenameName] = useState('')
  const [side, setSide] = useState(false)
  const [armed, setArmed] = useState(false)
  const [dropDir, setDropDir] = useState<DirId | null>(null)

  const visible = useMemo(() => visibleFiles(s), [s])
  const one = s.selected.length === 1 ? s.files.find((f) => f.key === s.selected[0]) || null : null

  useEffect(() => { void s.load(false) }, [])
  useEffect(() => {
    setConflictAsker((name) => new Promise((resolve) => {
      setConflictInput(name)
      setConflict({ name, resolve })
    }))
    setUploadDone((info) => {
      s.remember(info.url)
      s.prepend({ key: info.key, url: info.url, size: info.size, time: new Date().toISOString(), type: fileTypeOf(info.key) })
    })
  }, [s])

  useEffect(() => {
    let depth = 0
    const has = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const enter = (e: DragEvent) => { if (!has(e)) return; depth++; setDrop(true) }
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDrop(false) }
    const over = (e: DragEvent) => { if (depth) e.preventDefault() }
    const dropEv = (e: DragEvent) => {
      if (!depth) return
      e.preventDefault()
      depth = 0
      setDrop(false)
      if (e.dataTransfer?.files.length) enqueue([...e.dataTransfer.files])
    }
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean) as File[]
      if (files.length) enqueue(files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', dropEv)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', dropEv)
      window.removeEventListener('paste', paste)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '')
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === 'Escape') {
        setMenu(null); setQr(null); s.openLight(null); s.clearSel(); setSheet(false); return
      }
      if (typing) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !s.recent) {
        e.preventDefault()
        s.selectAll(visible.map((f) => f.key))
      } else if (e.key === 'Delete' && s.selected.length) {
        void s.removeKeys(s.selected)
      } else if (e.key === 'Enter' && one) {
        openFile(one)
      } else if (s.light && e.key === 'ArrowRight') step(1)
      else if (s.light && e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function step(d: number) {
    if (!s.light) return
    const i = visible.findIndex((f) => f.key === s.light!.key)
    if (i < 0) return
    s.openLight(visible[(i + d + visible.length) % visible.length])
  }
  function openFile(f: CloudFile) {
    const t = f.type || fileTypeOf(f.key)
    if (t === 'image' || t === 'video') s.openLight(f)
    else window.open(f.url, '_blank', 'noopener,noreferrer')
  }
  async function copy(files: CloudFile[], fmt = s.fmt) {
    const text = files.map((f) => formatLink(f, fmt)).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success((fmt === 'url' ? '链接' : fmt) + '已复制')
    } catch { toast.error('复制失败') }
  }
  async function showQr(url: string) {
    const img = await QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
    setQr({ url, img })
  }
  function download(f: CloudFile) {
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
  function onRowClick(e: React.MouseEvent, f: CloudFile) {
    if ((e.target as HTMLElement).closest('[data-stop]')) return
    if (narrow) { s.selectOnly(f.key); setSheet(true); return }
    if (e.detail > 1) return
    if (e.shiftKey) s.selectRange(f.key, visible.map((x) => x.key))
    else if (e.ctrlKey || e.metaKey) s.toggleKey(f.key)
    else if (!(s.selected.length === 1 && s.selected[0] === f.key)) s.selectOnly(f.key)
  }

  const dragging = useRef<string[]>([])
  const barRef = useRef<HTMLElement>(null)
  const [barH, setBarH] = useState(56)
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const measure = () => setBarH(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="shell-bg relative flex h-svh min-h-0 text-foreground">
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
                className={navClass(!s.recent && s.dir === d.id, dropDir === d.id)}
                onClick={() => { s.setDir(d.id); setSide(false) }}
                onDragOver={(e) => { if (d.id !== 'all' && dragging.current.length) { e.preventDefault(); setDropDir(d.id) } }}
                onDragLeave={() => setDropDir((cur) => cur === d.id ? null : cur)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDropDir(null)
                  if (d.id === 'all' || !dragging.current.length) return
                  void s.move(dragging.current, d.id)
                  dragging.current = []
                }}
              >
                {d.id === 'all' ? <Folder className="size-4" /> : d.id === 'img' ? <ImageIcon className="size-4" /> : d.id === 'video' ? <Film className="size-4" /> : <Box className="size-4" />}
                {d.label}
              </button>
            ))}
          </div>
          <p className="px-2.5 pt-4 pb-1 text-[11px] font-medium text-muted-foreground">本地</p>
          <button type="button" className={navClass(s.recent)} onClick={() => { s.setRecent(true); setSide(false) }}>
            <Clock className="size-4" /> 本机最近
          </button>
        </ScrollArea>
        <div className="flex items-center gap-1 border-t p-2">
          <IconTip label={theme === 'dark' ? '浅色' : '深色'}>
            <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="切换主题">
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </IconTip>
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => { clearSession(); s.setUnlocked(false) }}>
            <LogOut /> 退出
          </Button>
        </div>
      </aside>
      {side ? <button className="fixed inset-y-0 right-0 left-60 z-30 bg-black/15 backdrop-blur-sm md:hidden" onClick={() => setSide(false)} aria-label="关闭目录" /> : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {s.previewMode ? (
          <div className="flex items-center gap-2 border-b bg-muted/70 px-4 py-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            当前是预览，云端列表和上传要等接口可用
          </div>
        ) : null}
        <div
          className="min-h-0 flex-1 overflow-auto"
          onMouseDown={(e) => {
            if (e.button !== 0) return
            const t = e.target as HTMLElement
            if (t.closest('[data-file],[data-stop],button,a,input,label')) return
            s.clearSel()
          }}
          onClick={() => setMenu(null)}
        >
        <header ref={barRef} className="glass-bar sticky top-0 z-20 flex min-h-12 flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSide(true)} aria-label="目录"><Rows3 /></Button>
          <div className="flex min-w-0 items-center gap-1 text-sm">
            {s.recent ? <span className="font-medium">本机最近</span> : s.dir === 'all' ? <span className="font-medium">全部文件</span> : (
              <>
                <span className="text-muted-foreground">全部文件</span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{dirLabel(s.dir)}</span>
              </>
            )}
          </div>
          <div className="relative hidden min-w-40 max-w-xs flex-1 sm:block">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={s.query} onChange={(e) => s.setQuery(e.target.value)} placeholder="筛选当前目录" className="h-8 border-transparent bg-background/45 pl-8 shadow-none focus-visible:border-ring focus-visible:bg-background" />
          </div>
          {s.selected.length === 0 ? (
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <Select value={s.sort} onValueChange={(v) => s.setSort(v as typeof s.sort)}>
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
                <IconTip label="列表"><Button variant={s.view === 'list' ? 'secondary' : 'ghost'} size="icon-sm" onClick={() => s.setView('list')} aria-label="列表" aria-pressed={s.view === 'list'}><Rows3 /></Button></IconTip>
                <IconTip label="平铺"><Button variant={s.view === 'grid' ? 'secondary' : 'ghost'} size="icon-sm" onClick={() => s.setView('grid')} aria-label="平铺" aria-pressed={s.view === 'grid'}><LayoutGrid /></Button></IconTip>
                <IconTip label="瀑布流"><Button variant={s.view === 'fall' ? 'secondary' : 'ghost'} size="icon-sm" onClick={() => s.setView('fall')} aria-label="瀑布流" aria-pressed={s.view === 'fall'}><Columns2 /></Button></IconTip>
              </div>
              <IconTip label="刷新">
                <Button variant="ghost" size="icon" onClick={() => void s.load(false)} aria-label="刷新"><RefreshCw className={s.loading ? 'animate-spin' : ''} /></Button>
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
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">同名文件已存在时，上传会失败</p>
                  <label className="mt-3 flex items-center justify-between gap-3 py-1 text-sm">图片压缩为 WebP <Toggle checked={webp} onCheckedChange={(v) => { setWebp(!!v); localStorage.setItem('yunwo_webp', v ? '1' : '0') }} /></label>
                  {webp ? <div className="mt-3"><div className="mb-2 text-xs text-muted-foreground">画质 {quality}%</div><Slider value={[quality]} min={10} max={100} onValueChange={(v) => { const n = v[0] ?? 82; setQuality(n); localStorage.setItem('yunwo_quality', String(n)) }} /></div> : null}
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">单文件最大 {getMaxSizeMB()} MB · 大文件分片，可断点续传</p>
                </DropdownMenuContent>
              </DropdownMenu>
              <input id="file-pick" type="file" multiple hidden onChange={(e) => { enqueue([...(e.target.files || [])]); e.target.value = '' }} />
            </div>
          ) : (
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground tabular-nums">已选 {s.selected.length} 项</span>
              <Button size="sm" variant="outline" onClick={() => s.selectAll(visible.map((f) => f.key))}>全选</Button>
              <Button size="sm" variant="outline" onClick={() => s.invert(visible.map((f) => f.key))}>反选</Button>
              <Button size="sm" variant="outline" onClick={() => void copy(s.files.filter((f) => s.selected.includes(f.key)))}>复制链接</Button>
              <Button size="sm" variant="destructive" onClick={() => {
                if (!armed) { setArmed(true); window.setTimeout(() => setArmed(false), 3000); return }
                setArmed(false); void s.removeKeys(s.selected)
              }}>{armed ? `再点确认删除 ${s.selected.length} 个` : '删除'}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setArmed(false); s.clearSel() }}>取消</Button>
            </div>
          )}
        </header>

          {s.recent ? <Recent /> : s.loading ? (
            <div className="px-3 py-2">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="flex h-12 items-center gap-3">
                  <div className="size-4 animate-pulse rounded bg-muted" />
                  <div className="size-9 animate-pulse rounded-md bg-muted" />
                  <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${36 + (i % 4) * 10}%` }} />
                </div>
              ))}
            </div>
          ) : (
            <FileView
              view={s.view}
              files={visible}
              selected={s.selected}
              hint={s.hint}
              query={s.query}
              onUpload={() => document.getElementById('file-pick')?.click()}
              onClick={onRowClick}
              onDouble={(f) => openFile(f)}
              onCheck={(key) => s.toggleKey(key)}
              onMenu={(e, f) => { e.preventDefault(); s.selectOnly(f.key); setMenu({ x: e.clientX, y: e.clientY, file: f }) }}
              onDragStart={(f) => { dragging.current = s.selected.includes(f.key) ? [...s.selected] : [f.key] }}
              stickyTop={barH}
            />
          )}
        </div>
        {!s.recent ? (
          <footer className="glass-bar flex h-9 items-center gap-3 border-t px-4 text-xs text-muted-foreground">
            <span className="tabular-nums">{s.query ? `筛选出 ${visible.length} / 共 ${s.files.length}` : `${s.files.length} 个文件`}</span>
            {s.hint && s.files.length ? <span className="truncate text-amber-700 dark:text-amber-300">{s.hint}</span> : null}
            {s.truncated ? <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void s.load(true)}>加载更多</Button> : null}
          </footer>
        ) : null}
      </div>

      {one && !narrow && !s.recent ? <Inspector file={one} fmt={s.fmt} onFmt={(f) => { s.setFmt(f); void copy([one], f) }} onOpen={() => openFile(one)} onDown={() => download(one)} onQr={() => void showQr(one.url)} onRename={() => { setRenameName(fileNameOf(one.key)); s.setRenameFor(one) }} onDelete={() => void s.removeKeys([one.key])} onMove={(d) => void s.move([one.key], d)} /> : null}

      <Sheet open={!!(narrow && sheet && one)} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="glass max-h-[80svh] overflow-auto">
          <SheetHeader><SheetTitle>详细信息</SheetTitle></SheetHeader>
          {one ? <InspectorBody file={one} fmt={s.fmt} onFmt={(f) => { s.setFmt(f); void copy([one], f) }} onOpen={() => openFile(one)} onDown={() => download(one)} onQr={() => void showQr(one.url)} onRename={() => { setRenameName(fileNameOf(one.key)); s.setRenameFor(one) }} onDelete={() => void s.removeKeys([one.key])} onMove={(d) => void s.move([one.key], d)} /> : null}
        </SheetContent>
      </Sheet>

      {menu ? <button type="button" className="fixed inset-0 z-40 cursor-default" aria-label="关闭菜单" onClick={() => setMenu(null)} /> : null}
      {menu ? (
        <div className="glass fixed z-50 min-w-44 origin-top-left animate-in rounded-xl border p-1 text-sm shadow-lg fade-in-0 duration-100" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 320) }}>
          <MenuBtn onClick={() => { openFile(menu.file); setMenu(null) }}>打开</MenuBtn>
          {(['url', 'md', 'html', 'bbcode'] as LinkFmt[]).map((f) => <MenuBtn key={f} onClick={() => { s.setFmt(f); void copy(s.selected.length > 1 ? s.files.filter((x) => s.selected.includes(x.key)) : [menu.file], f); setMenu(null) }}>复制 {f.toUpperCase()}</MenuBtn>)}
          <MenuBtn onClick={() => { download(menu.file); setMenu(null) }}>下载</MenuBtn>
          <MenuBtn onClick={() => { void showQr(menu.file.url); setMenu(null) }}>二维码</MenuBtn>
          <MenuBtn onClick={() => { setRenameName(fileNameOf(menu.file.key)); s.setRenameFor(menu.file); setMenu(null) }}>重命名</MenuBtn>
          <div className="my-1 h-px bg-border" />
          <div className="px-2 py-1 text-[11px] text-muted-foreground">移动到</div>
          {(['img', 'video', 'other'] as const).map((d) => (
            <MenuBtn key={d} disabled={dirOf(menu.file.key) === d} onClick={() => { void s.move(s.selected.includes(menu.file.key) ? s.selected : [menu.file.key], d); setMenu(null) }}>{dirLabel(d)}</MenuBtn>
          ))}
          <MenuBtn className="text-destructive" onClick={() => { void s.removeKeys(s.selected.includes(menu.file.key) ? s.selected : [menu.file.key]); setMenu(null) }}>删除</MenuBtn>
        </div>
      ) : null}

      <Dialog open={!!s.light} onOpenChange={(o) => { if (!o) s.openLight(null) }}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader><DialogTitle className="truncate">{s.light ? fileNameOf(s.light.key) : ''}</DialogTitle></DialogHeader>
          {s.light ? <Preview file={s.light} /> : null}
          <p className="text-xs leading-relaxed break-all text-muted-foreground">{s.light ? `${s.light.key} · ${sizeText(s.light.size)} · ${fmtTime(s.light.time)}` : ''}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => step(-1)}>上一个</Button>
            <Button variant="outline" onClick={() => step(1)}>下一个</Button>
            {s.light ? <Button onClick={() => void copy([s.light!])}>复制链接</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!s.renameFor} onOpenChange={(o) => { if (!o) s.setRenameFor(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>重命名</DialogTitle></DialogHeader>
          <Input value={renameName} onChange={(e) => setRenameName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && s.renameFor) void s.rename(s.renameFor.key, renameName.trim()) }} />
          <DialogFooter>
            <Button variant="outline" onClick={() => s.setRenameFor(null)}>取消</Button>
            <Button onClick={() => s.renameFor && void s.rename(s.renameFor.key, renameName.trim())}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!conflict} onOpenChange={(o) => { if (!o && conflict) { conflict.resolve(null); setConflict(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>已存在同名文件</DialogTitle></DialogHeader>
          <p className="text-xs leading-relaxed break-all text-muted-foreground">{conflict?.name}</p>
          <Input value={conflictInput} onChange={(e) => setConflictInput(e.target.value)} />
          <DialogFooter className="sm:flex-wrap">
            <Button variant="outline" onClick={() => { conflict?.resolve(null); setConflict(null) }}>取消</Button>
            <Button variant="outline" onClick={() => { conflict?.resolve('__auto__'); setConflict(null) }}>加编码继续</Button>
            <Button onClick={() => { if (!conflictInput.trim()) { toast.error('文件名不能为空'); return } conflict?.resolve(conflictInput.trim()); setConflict(null) }}>重命名上传</Button>
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

      {drop ? <div className="pointer-events-none fixed inset-0 z-50 grid animate-in place-items-center bg-background/55 fade-in-0 backdrop-blur-md duration-150"><div className="glass rounded-2xl border border-dashed border-foreground/25 px-16 py-12 text-center shadow-sm"><div className="text-lg font-semibold">松开即上传</div><div className="mt-1 text-sm text-muted-foreground">文件会按类型放进图片、视频或其他</div></div></div> : null}
      <Transfer items={queue} summary={summary} folded={folded} setFolded={setFolded} />
    </div>
  )
}

function MenuBtn({ children, onClick, disabled, className = '' }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={`flex h-8 w-full items-center rounded-md px-2 text-left transition-colors duration-150 hover:bg-muted disabled:opacity-40 ${className}`}>{children}</button>
}

function Preview({ file }: { file: CloudFile }) {
  const t = file.type || fileTypeOf(file.key)
  if (t === 'image') return <div className="grid max-h-[68vh] place-items-center overflow-hidden rounded-lg bg-muted"><img src={file.url} alt="" className="max-h-[68vh] w-full object-contain" /></div>
  if (t === 'video') return <video src={file.url} controls className="max-h-[68vh] w-full rounded-lg bg-black" />
  return <div className="grid place-items-center rounded-lg border bg-muted/40 py-16 text-sm">{fileNameOf(file.key)}</div>
}

const LIST_COLS = 'grid grid-cols-[36px_44px_minmax(0,1fr)_32px] items-center sm:grid-cols-[36px_44px_minmax(0,1fr)_88px_32px] lg:grid-cols-[36px_44px_minmax(0,1fr)_88px_148px_32px]'

function FileView(props: {
  view: 'list' | 'grid' | 'fall'
  files: CloudFile[]
  selected: string[]
  hint: string
  query: string
  onUpload: () => void
  onClick: (e: React.MouseEvent, f: CloudFile) => void
  onDouble: (f: CloudFile) => void
  onCheck: (key: string) => void
  onMenu: (e: React.MouseEvent, f: CloudFile) => void
  onDragStart: (f: CloudFile) => void
  stickyTop: number
}) {
  if (!props.files.length) {
    const filtered = !!props.query
    return (
      <div className="grid min-h-[52vh] place-items-center px-6">
        <div className="max-w-xs text-center">
          <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
            {filtered ? <Search className="size-5" /> : <Folder className="size-5" />}
          </div>
          <div className="text-sm font-medium">{filtered ? '没有匹配的文件' : props.hint ? '暂时看不到云端文件' : '这个文件夹是空的'}</div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {filtered ? `没有名称包含「${props.query}」的文件` : props.hint || '把文件拖进窗口，或从右上角上传'}
          </p>
          {!filtered && !props.hint ? <Button className="mt-4" data-stop onClick={props.onUpload}><Upload /> 上传</Button> : null}
        </div>
      </div>
    )
  }
  if (props.view === 'list') {
    return (
      <div className="min-w-0 px-1">
        <div className={`${LIST_COLS} glass-bar sticky z-10 border-b px-2 text-[11px] text-muted-foreground`} style={{ top: props.stickyTop }}>
          <span /><span /><span className="py-2">名称</span>
          <span className="hidden py-2 text-right sm:block">大小</span>
          <span className="hidden py-2 text-right lg:block">修改时间</span>
          <span />
        </div>
        {props.files.map((f) => {
          const on = props.selected.includes(f.key)
          return (
            <div
              key={f.key}
              data-file
              draggable
              onDragStart={() => props.onDragStart(f)}
              onClick={(e) => props.onClick(e, f)}
              onDoubleClick={() => props.onDouble(f)}
              onContextMenu={(e) => props.onMenu(e, f)}
              className={`${LIST_COLS} group min-h-12 border-b border-border/70 px-2 py-2 text-sm transition-colors duration-150 last:border-b-0 ${on ? 'file-selected' : 'hover:bg-muted/70'}`}
            >
              <Checkbox data-stop className="justify-self-center" checked={on} onCheckedChange={() => props.onCheck(f.key)} onClick={(e) => e.stopPropagation()} />
              <Thumb file={f} />
              <div className="min-w-0 pr-3" title={fileNameOf(f.key)}>
                <div className="truncate">{fileNameOf(f.key)}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground sm:hidden">{sizeText(f.size)} · {fmtTime(f.time)}</div>
              </div>
              <div className="hidden text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:block">{sizeText(f.size)}</div>
              <div className="hidden text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:block">{fmtTime(f.time)}</div>
              <Button data-stop variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={(e) => { e.stopPropagation(); props.onMenu(e, f) }} aria-label="更多"><MoreHorizontal /></Button>
            </div>
          )
        })}
      </div>
    )
  }
  const fall = props.view === 'fall'
  return (
    <div className={fall ? 'columns-[210px] gap-3 p-4' : 'grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 p-4'}>
      {props.files.map((f) => {
        const on = props.selected.includes(f.key)
        return (
          <div
            key={f.key}
            data-file
            draggable
            onDragStart={() => props.onDragStart(f)}
            onClick={(e) => props.onClick(e, f)}
            onDoubleClick={() => props.onDouble(f)}
            onContextMenu={(e) => props.onMenu(e, f)}
            className={`group relative rounded-xl ${on ? 'ring-2 ring-[oklch(0.58_0.16_255)]' : ''} ${fall ? 'mb-3 break-inside-avoid' : ''}`}
          >
            <div className={`relative overflow-hidden rounded-xl border bg-muted/30 ${on ? 'border-transparent' : ''} ${fall ? '' : 'aspect-square'}`}>
              <Thumb file={f} mode={fall ? 'natural' : 'cover'} />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-2.5 pt-8 text-xs text-white">
                <div className="truncate">{fileNameOf(f.key)}</div>
                <div className="mt-0.5 opacity-70 tabular-nums">{sizeText(f.size)}</div>
              </div>
              <div className={`glass absolute top-2 left-2 rounded-md p-0.5 shadow-sm ${on ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100'}`} data-stop>
                <Checkbox checked={on} onCheckedChange={() => props.onCheck(f.key)} onClick={(e) => e.stopPropagation()} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function frameSrc(url: string) {
  return url.includes('#') ? url : `${url}#t=0.1`
}

function VideoFrame({ url, className }: { url: string; className: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <div className={`grid place-items-center bg-muted ${className}`}><Film className="size-4 text-muted-foreground" /></div>
  }
  return (
    <video
      muted
      playsInline
      preload="metadata"
      src={frameSrc(url)}
      className={`pointer-events-none bg-black ${className}`}
      onError={() => setFailed(true)}
    />
  )
}

function Thumb({ file, mode = 'cell' }: { file: CloudFile; mode?: 'cell' | 'cover' | 'natural' }) {
  const t = file.type || fileTypeOf(file.key)
  const ext = (file.key.split('.').pop() || 'file').slice(0, 4).toUpperCase()
  if (t === 'image' && mode === 'natural') return <img src={file.url} alt="" loading="lazy" decoding="async" className="block h-auto w-full" />
  if (t === 'image') {
    const cell = mode === 'cell'
    return (
      <div className={cell ? 'size-9 overflow-hidden rounded-md bg-muted' : 'h-full w-full overflow-hidden bg-muted'}>
        <img src={file.url} alt="" loading="lazy" decoding="async" className={cell ? 'size-9 object-cover' : 'h-full w-full object-cover'} />
      </div>
    )
  }
  if (t === 'video') {
    if (mode === 'cell') {
      return <div className="size-9 overflow-hidden rounded-md bg-black"><VideoFrame url={file.url} className="size-9 object-cover" /></div>
    }
    if (mode === 'natural') return <VideoFrame url={file.url} className="aspect-video max-h-[420px] w-full object-cover" />
    return <VideoFrame url={file.url} className="h-full w-full object-cover" />
  }
  const box = mode === 'cell' ? 'grid size-9 place-items-center overflow-hidden rounded-md bg-muted' : mode === 'natural' ? 'grid aspect-[4/3] w-full place-items-center bg-muted' : 'grid h-full w-full place-items-center bg-muted'
  return <div className={`${box} text-[10px] font-medium text-muted-foreground`}>{ext}</div>
}

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
function InspectorBody({ file, fmt, onFmt, onOpen, onDown, onQr, onRename, onDelete, onMove }: { file: CloudFile } & InspectorActions) {
  const t = file.type || fileTypeOf(file.key)
  return (
    <div className="space-y-4 px-4 pb-6">
      <div className="grid h-40 place-items-center overflow-hidden rounded-xl bg-muted">
        {t === 'image' ? <img src={file.url} alt="" className="max-h-40 w-full object-contain" /> : t === 'video' ? <VideoFrame url={file.url} className="max-h-40 w-full object-contain" /> : <span className="text-sm text-muted-foreground">文件</span>}
      </div>
      <div className="text-sm leading-snug font-medium break-all">{fileNameOf(file.key)}</div>
      <dl className="text-xs">
        {([
          ['大小', sizeText(file.size)],
          ['类型', t === 'image' ? '图片' : t === 'video' ? '视频' : '文件'],
          ['修改时间', fmtTime(file.time)],
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

function Recent() {
  const tick = useDrive((s) => s.histTick)
  const wipe = useDrive((s) => s.wipeHistory)
  const fmt = useDrive((s) => s.fmt)
  const items = useMemo(() => getHistSafe(), [tick])
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
          {items.map((it) => (
            <button key={it.url + it.t} type="button" className="overflow-hidden rounded-xl border bg-card text-left transition-colors duration-150 hover:border-foreground/20" onClick={() => navigator.clipboard.writeText(formatLink({ key: it.url, url: it.url, type: fileTypeOf(it.url) }, fmt)).then(() => toast.success('已复制'))}>
              {fileTypeOf(it.url) === 'image' ? <img src={it.url} alt="" className="aspect-square w-full object-cover" /> : fileTypeOf(it.url) === 'video' ? <VideoFrame url={it.url} className="aspect-square w-full object-cover" /> : <div className="grid aspect-square place-items-center bg-muted text-xs text-muted-foreground">文件</div>}
              <div className="truncate px-2 py-1.5 text-xs">{fileNameOf(it.url)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
function getHistSafe() {
  return useDrive.getState().history()
}

function Transfer({ items, summary, folded, setFolded }: { items: QueueItem[]; summary: ReturnType<typeof queueSummary>; folded: boolean; setFolded: (v: boolean) => void }) {
  if (!items.length) return null
  return (
    <div className="glass fixed right-4 bottom-4 z-40 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border shadow-lg ring-1 ring-foreground/10">
      <button type="button" className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm" onClick={() => setFolded(!folded)}>
        <span className="font-medium">{summary.title}</span>
        <span className="text-xs text-muted-foreground">{folded ? '展开' : '收起'}</span>
      </button>
      <Progress value={summary.agg} className="h-0.5 rounded-none" />
      {!folded ? (
        <div className="max-h-80 space-y-2 overflow-auto p-2">
          {items.map((it) => (
            <div key={it.id} className="rounded-lg bg-muted/50 p-2">
              <div className="truncate text-sm">{it.file.name}</div>
              <div className={`text-xs ${it.tone === 'err' ? 'text-destructive' : it.tone === 'ok' ? 'text-emerald-600' : 'text-muted-foreground'}`}>{it.text}</div>
              <Progress value={it.pct} className="mt-1 h-1" />
              <div className="mt-1 flex gap-1">
                {it.state === 'uploading' ? <><Button size="xs" variant="outline" onClick={() => pauseItem(it)}>暂停</Button><Button size="xs" variant="ghost" onClick={() => void cancelItem(it)}>取消</Button></> : null}
                {it.state === 'paused' ? <><Button size="xs" onClick={() => resumeItem(it)}>继续</Button><Button size="xs" variant="ghost" onClick={() => void cancelItem(it)}>取消</Button></> : null}
                {it.state === 'queued' ? <Button size="xs" variant="ghost" onClick={() => void cancelItem(it)}>取消</Button> : null}
                {(it.state === 'done' || it.state === 'err') ? <Button size="xs" variant="ghost" onClick={() => void cancelItem(it)}>移除</Button> : null}
              </div>
            </div>
          ))}
          {!summary.active ? <Button size="sm" variant="ghost" onClick={clearFinished}>清空</Button> : null}
        </div>
      ) : null}
    </div>
  )
}
