export type FileKind = 'image' | 'video' | 'other'
export type DirId = 'all' | 'img' | 'video' | 'other'
export type ViewMode = 'list' | 'grid' | 'fall'
export type SortMode = 'time_desc' | 'time_asc' | 'size_desc' | 'size_asc' | 'name_asc' | 'name_desc'
export type LinkFmt = 'url' | 'md' | 'html' | 'bbcode'

export type CloudFile = {
  key: string
  url: string
  size?: number
  time?: string
  type?: FileKind
}

export const IMG_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'tiff']
export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'flv', 'ts']

export const DIRS: { id: DirId; label: string }[] = [
  { id: 'all', label: '全部文件' },
  { id: 'img', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'other', label: '其他' },
]

export function fileTypeOf(name: string): FileKind {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (IMG_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  return 'other'
}

export function fileNameOf(key: string) {
  return key.split('/').pop() || '未命名'
}

export function dirOf(key: string): DirId {
  const d = key.split('/')[1]
  if (d === 'img' || d === 'video' || d === 'other') return d
  return 'other'
}

export function dirLabel(d: string) {
  return { img: '图片', video: '视频', other: '其他', all: '全部文件' }[d] || d
}

export function fmtSize(bytes: number) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1073741824) return (n / 1073741824).toFixed(n >= 10737418240 ? 1 : 2) + ' GB'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return Math.round(n) + ' B'
}

export function sizeText(n?: number | null) {
  if (n == null) return '—'
  return fmtSize(n)
}

export function fmtTime(t?: string) {
  if (!t) return '—'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatLink(f: { key: string; url: string; type?: FileKind }, fmt: LinkFmt) {
  const name = fileNameOf(f.key)
  const t = f.type || fileTypeOf(f.key)
  if (fmt === 'md') return t === 'image' ? `![img](${f.url})` : `[${name}](${f.url})`
  if (fmt === 'html') {
    if (t === 'image') return `<img src="${f.url}" alt="${name}">`
    if (t === 'video') return `<video src="${f.url}" controls></video>`
    return `<a href="${f.url}">${name}</a>`
  }
  if (fmt === 'bbcode') return t === 'image' ? `[img]${f.url}[/img]` : `[url=${f.url}]${name}[/url]`
  return f.url
}

export function sortFiles(items: CloudFile[], sort: SortMode) {
  const arr = [...items]
  const name = (f: CloudFile) => fileNameOf(f.key)
  if (sort === 'time_asc') arr.sort((a, b) => +new Date(a.time || 0) - +new Date(b.time || 0))
  else if (sort === 'size_desc') arr.sort((a, b) => (b.size || 0) - (a.size || 0))
  else if (sort === 'size_asc') arr.sort((a, b) => (a.size || 0) - (b.size || 0))
  else if (sort === 'name_asc') arr.sort((a, b) => name(a).localeCompare(name(b), 'zh'))
  else if (sort === 'name_desc') arr.sort((a, b) => name(b).localeCompare(name(a), 'zh'))
  else arr.sort((a, b) => +new Date(b.time || 0) - +new Date(a.time || 0))
  return arr
}

const NAME_RE = /^[A-Za-z0-9._\-一-鿿㐀-䶿가-힯ㄱ-ㅣ぀-ヿ]+$/
export function validName(name: string) {
  return NAME_RE.test(name) && !name.startsWith('.') && !name.includes('..') && name.length <= 200
}
