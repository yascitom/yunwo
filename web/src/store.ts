import { create } from 'zustand'
import { toast } from 'sonner'
import { listFiles, deleteFile, renameFile, moveFile, ApiError } from '@/lib/api'
import { addHist, clearHist, getHist, type HistItem } from '@/lib/auth'
import { dirLabel, fileNameOf, fileTypeOf, filterFiles, sortFiles, validName, type CloudFile, type DirId, type LinkFmt, type SortMode, type ViewMode } from '@/lib/files'
import { setMaxSizeMB } from '@/lib/upload'

const VIEW_KEY = 'yunwo_view'
const SORT_KEY = 'yunwo_sort'
const FMT_KEY = 'yunwo_copyfmt'

function readView(): ViewMode {
  const v = localStorage.getItem(VIEW_KEY)
  return v === 'grid' || v === 'fall' || v === 'list' ? v : 'list'
}
function readSort(): SortMode {
  const s = localStorage.getItem(SORT_KEY) as SortMode | null
  const ok: SortMode[] = ['time_desc', 'time_asc', 'size_desc', 'size_asc', 'name_asc', 'name_desc']
  return s && ok.includes(s) ? s : 'time_desc'
}
function readFmt(): LinkFmt {
  const f = localStorage.getItem(FMT_KEY) as LinkFmt | null
  return f === 'md' || f === 'html' || f === 'bbcode' || f === 'url' ? f : 'url'
}

type State = {
  unlocked: boolean
  previewMode: boolean
  maxMB: number
  bootMsg: string
  files: CloudFile[]
  cursor: string
  truncated: boolean
  dir: DirId
  recent: boolean
  view: ViewMode
  sort: SortMode
  query: string
  selected: string[]
  anchor: string
  loading: boolean
  hint: string
  fmt: LinkFmt
  light: CloudFile | null
  renameFor: CloudFile | null
  setUnlocked: (v: boolean, preview?: boolean, maxMB?: number) => void
  setBootMsg: (s: string) => void
  setDir: (d: DirId) => void
  setRecent: (v: boolean) => void
  setView: (v: ViewMode) => void
  setSort: (s: SortMode) => void
  setQuery: (q: string) => void
  setFmt: (f: LinkFmt) => void
  selectOnly: (key: string) => void
  toggleKey: (key: string) => void
  selectRange: (key: string, visible: string[]) => void
  selectAll: (keys: string[]) => void
  histTick: number
  invert: (keys: string[]) => void
  clearSel: () => void
  load: (append?: boolean) => Promise<void>
  prepend: (f: CloudFile) => void
  removeKeys: (keys: string[]) => Promise<void>
  rename: (key: string, name: string) => Promise<void>
  move: (keys: string[], dir: Exclude<DirId, 'all'>) => Promise<void>
  openLight: (f: CloudFile | null) => void
  setRenameFor: (f: CloudFile | null) => void
  remember: (url: string) => void
  history: () => HistItem[]
  wipeHistory: () => void
}

export const useDrive = create<State>((set, get) => ({
  unlocked: false,
  previewMode: false,
  maxMB: 100,
  bootMsg: '',
  files: [],
  cursor: '',
  truncated: false,
  dir: 'all',
  recent: false,
  view: readView(),
  sort: readSort(),
  query: '',
  selected: [],
  anchor: '',
  loading: false,
  hint: '',
  fmt: readFmt(),
  light: null,
  renameFor: null,
  histTick: 0,
  setUnlocked: (v, preview = false, maxMB) => {
    if (maxMB) setMaxSizeMB(maxMB)
    set({ unlocked: v, previewMode: preview, maxMB: maxMB || get().maxMB, bootMsg: '' })
  },
  setBootMsg: (bootMsg) => set({ bootMsg }),
  setDir: (dir) => {
    set({ dir, recent: false, selected: [], cursor: '', files: [] })
    void get().load(false)
  },
  setRecent: (recent) => set({ recent }),
  setView: (view) => {
    localStorage.setItem(VIEW_KEY, view)
    set({ view })
  },
  setSort: (sort) => {
    localStorage.setItem(SORT_KEY, sort)
    set({ sort })
  },
  setQuery: (query) => set({ query }),
  setFmt: (fmt) => {
    localStorage.setItem(FMT_KEY, fmt)
    set({ fmt })
  },
  selectOnly: (key) => set({ selected: [key], anchor: key }),
  toggleKey: (key) => set((s) => ({
    selected: s.selected.includes(key) ? s.selected.filter((k) => k !== key) : [...s.selected, key],
    anchor: key,
  })),
  selectRange: (key, visible) => {
    const anchor = get().anchor || key
    const a = visible.indexOf(anchor)
    const b = visible.indexOf(key)
    if (a < 0 || b < 0) { set({ selected: [key], anchor: key }); return }
    const [lo, hi] = a < b ? [a, b] : [b, a]
    set({ selected: visible.slice(lo, hi + 1), anchor })
  },
  selectAll: (keys) => set({ selected: keys }),
  invert: (keys) => set((s) => {
    const next = new Set(s.selected)
    keys.forEach((k) => { if (next.has(k)) next.delete(k); else next.add(k) })
    return { selected: [...next] }
  }),
  clearSel: () => set({ selected: [], anchor: '' }),
  load: async (append = false) => {
    const { dir, cursor } = get()
    if (!append) set({ loading: true, hint: '', files: [], cursor: '', truncated: false, selected: [] })
    try {
      const data = await listFiles(dir, append ? cursor : '')
      const incoming = (data.files || []).map((f) => ({ ...f, type: f.type || fileTypeOf(f.key) }))
      set((s) => ({
        files: append ? s.files.concat(incoming) : incoming,
        cursor: data.nextToken || '',
        truncated: !!data.truncated,
        loading: false,
        hint: '',
      }))
    } catch (e) {
      const err = e as ApiError
      const soft = err.code === 'PREVIEW' || err.code === 'NETWORK' || err.status === 404 || err.status >= 500
      set({
        loading: false,
        files: append ? get().files : [],
        hint: soft ? (err.message || '接口暂时不可用') : '加载失败：' + err.message,
      })
    }
  },
  prepend: (f) => {
    const { dir } = get()
    const type = f.type || fileTypeOf(f.key)
    const mapped = type === 'image' ? 'img' : type === 'video' ? 'video' : 'other'
    if (dir !== 'all' && mapped !== dir) return
    set((s) => ({ files: [{ ...f, type }, ...s.files.filter((x) => x.key !== f.key)] }))
  },
  removeKeys: async (keys) => {
    let ok = 0
    for (const key of keys) {
      try {
        await deleteFile(key)
        ok++
        set((s) => ({ files: s.files.filter((f) => f.key !== key), selected: s.selected.filter((k) => k !== key) }))
      } catch (e) {
        toast.error(fileNameOf(key) + '：' + (e as Error).message)
      }
    }
    if (ok) toast.success('已删除 ' + ok + ' 个文件')
    if (get().light && keys.includes(get().light!.key)) set({ light: null })
  },
  rename: async (key, name) => {
    if (!validName(name)) { toast.error('文件名只允许中日韩文字、字母、数字、点、下划线、连字符'); return }
    if (name === fileNameOf(key)) { set({ renameFor: null }); return }
    try {
      const data = await renameFile(key, name)
      set((s) => ({
        files: s.files.map((f) => f.key === key ? { ...f, key: data.key, url: data.url } : f),
        selected: s.selected.map((k) => k === key ? data.key : k),
        light: s.light?.key === key ? { ...s.light, key: data.key, url: data.url } : s.light,
        renameFor: null,
      }))
      toast.success('已重命名为 ' + name)
      if (data.warn) toast.error(data.warn)
    } catch (e) {
      toast.error((e as Error).message)
    }
  },
  move: async (keys, dir) => {
    const targets = get().files.filter((f) => keys.includes(f.key) && f.key.split('/')[1] !== dir)
    if (!targets.length) { toast('文件已在「' + dirLabel(dir) + '」'); return }
    let ok = 0
    for (const f of targets) {
      try {
        const data = await moveFile(f.key, dir)
        set((s) => ({
          files: s.files.map((x) => x.key === f.key ? { ...x, key: data.key, url: data.url } : x),
          selected: s.selected.map((k) => k === f.key ? data.key : k),
          light: s.light?.key === f.key ? { ...s.light, key: data.key, url: data.url } : s.light,
        }))
        if (data.warn) toast.error(data.warn)
        ok++
      } catch (e) {
        toast.error(fileNameOf(f.key) + '：' + (e as Error).message)
      }
    }
    if (get().dir !== 'all') await get().load(false)
    if (ok) toast.success('已移动 ' + ok + ' 个文件到「' + dirLabel(dir) + '」')
  },
  openLight: (light) => set({ light }),
  setRenameFor: (renameFor) => set({ renameFor }),
  remember: (url) => { addHist(url); set((s) => ({ histTick: s.histTick + 1 })) },
  history: () => getHist(),
  wipeHistory: () => { clearHist(); set((s) => ({ histTick: s.histTick + 1 })) },
}))

export function visibleFiles(s: Pick<State, 'files' | 'query' | 'sort'>) {
  return filterFiles(sortFiles(s.files, s.sort), s.query)
}

let pickedFrom: string[] | null = null
let pickedSet = new Set<string>()

export function isPicked(selected: string[], key: string) {
  if (pickedFrom !== selected) {
    pickedFrom = selected
    pickedSet = new Set(selected)
  }
  return pickedSet.has(key)
}

const pickedSel = new Map<string, (s: State) => boolean>()

export function pickedSelector(key: string) {
  let fn = pickedSel.get(key)
  if (!fn) {
    fn = (s) => isPicked(s.selected, key)
    pickedSel.set(key, fn)
  }
  return fn
}
