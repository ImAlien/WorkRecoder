import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Menu } from 'electron'
import { join, basename, extname } from 'path'
import {
  readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, copyFileSync,
  statSync, readdirSync, unlinkSync
} from 'fs'
import { execFile } from 'child_process'
import { hostname } from 'os'
import { randomUUID, createHash } from 'crypto'

// 固定数据目录名：保证「开发模式(npm run dev)」和「打包后的 exe」读写同一份数据，
// 不受打包时 productName（工作记录本）影响。数据始终在 %APPDATA%\workrecoder\ 下。
try {
  app.setPath('userData', join(app.getPath('appData'), 'workrecoder'))
} catch { /* appData 不可用时退回默认路径 */ }

// ---------------------------------------------------------------------------
// JSON 数据存储（存在系统 userData 目录，卸载/重装数据不丢）
// 一条记录 = { id, title, body(HTML), tags[], created_at, updated_at }
// 图片以 base64 内嵌在 body 的 <img src="data:..."> 里，无需单独存储
// ---------------------------------------------------------------------------
let dataFile = ''
let syncConfigFile = ''   // %APPDATA%\workrecoder\workrecoder-sync.json（不进入同步内容）
let syncDir = ''          // %APPDATA%\workrecoder\sync-repo（与远端交互的 git 仓库）
let attachDir = ''        // %APPDATA%\workrecoder\attachments（附件本体，按内容哈希命名）
let syncStateFile = ''    // %APPDATA%\workrecoder\workrecoder-sync-state.json（上次同步进度，只驱动状态灯）
// store = { records:[{id, uid, title, body, tags[], created_at, updated_at, ver}], nextId, deleted:[{uid, deleted_at, ver}], clock }
// uid 是跨机器同步的稳定身份（合并按 uid 认记录）；整数 id 仅作本地句柄，合并后会重排。
// ver 是每条记录的 Lamport 版本号（本地每次改动 +1），合并时“版本高者胜”，不依赖系统时钟，
// 时间戳仅在版本相同时作次级判定——避免两台机器时钟不准导致旧改动覆盖新改动/删除丢失。
// clock 是本 store 的 Lamport 计数器；deleted 是“墓碑”列表，让删除也能在合并时传播。
let store = { records: [], nextId: 1, deleted: [], clock: 0 }

function loadStore() {
  dataFile = join(app.getPath('userData'), 'workrecoder-data.json')
  syncConfigFile = join(app.getPath('userData'), 'workrecoder-sync.json')
  syncDir = join(app.getPath('userData'), 'sync-repo')
  attachDir = join(app.getPath('userData'), ATTACH_DIR_NAME)
  syncStateFile = join(app.getPath('userData'), 'workrecoder-sync-state.json')
  if (existsSync(dataFile)) {
    try {
      store = JSON.parse(readFileSync(dataFile, 'utf-8'))
    } catch {
      // 数据文件损坏：绝不静默丢弃。先把损坏文件改名保留，再从空存储开始，
      // 这样后续写入不会覆盖掉原始（可能可人工恢复的）数据。
      const backup = dataFile + '.corrupt-' + Date.now() + '.json'
      try { renameSync(dataFile, backup) } catch { /* 改名失败也不覆盖原文件 */ }
      store = { records: [], nextId: 1, deleted: [], clock: 0 }
    }
  } else {
    store = { records: [], nextId: 1, deleted: [], clock: 0 }
    saveStore()
  }
  if (!Array.isArray(store.records)) store.records = []
  if (!Array.isArray(store.deleted)) store.deleted = []
  if (typeof store.clock !== 'number' || !isFinite(store.clock)) store.clock = 0
  // 兼容/规整
  let changed = false
  store.records.forEach((r) => {
    r.tags = normTags(r.tags)
    // 附件元数据同样要规整：file 字段可能来自同步/导入，必须过滤掉非法命名
    r.attachments = normAttachments(r.attachments)
    // 旧数据补全同步身份：用内容派生的稳定 uid（而非随机），保证同一份数据在两台机器上
    // 迁移后得到相同 uid，首次合并不会重复、删除也能正确传播。
    if (!r.uid) { r.uid = stableUid(r); changed = true }
    if (typeof r.ver !== 'number' || !isFinite(r.ver)) { r.ver = 1; changed = true }
  })
  store.deleted.forEach((d) => {
    if (d && (typeof d.ver !== 'number' || !isFinite(d.ver))) { d.ver = 1; changed = true }
  })
  // Lamport 时钟不小于已见过的最大版本（用 reduce 避免大数组 spread 触发调用栈上限）
  let maxVer = 0
  for (const r of store.records) maxVer = Math.max(maxVer, r.ver || 0)
  for (const d of store.deleted) maxVer = Math.max(maxVer, (d && d.ver) || 0)
  if (store.clock < maxVer) { store.clock = maxVer; changed = true }
  if (!store.nextId) {
    store.nextId = store.records.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1
  }
  if (changed) saveStore() // 首次补 uid/ver 后持久化
}

// 原子写：先写临时文件再 rename，避免写一半崩溃导致主文件损坏/半截
function saveStore() {
  const tmp = dataFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  renameSync(tmp, dataFile)
}

function now() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 由内容派生的稳定 uid（仅用于给缺 uid 的历史/导入记录补身份）：
// 同一条记录在两台机器上迁移后得到相同 uid，避免首次合并重复、删除失效。
// 基于原始导入字段（不含 now()），保证同一份文件重复导入结果一致。
function stableUid(r) {
  const basis = String((r && r.created_at) || '') + '\0' +
    String((r && r.title) || '') + '\0' + String((r && r.body) || '')
  return createHash('sha256').update(basis).digest('hex').slice(0, 32)
}

// Lamport 版本号：任一本地改动（新建/编辑/删除）都推进全局计数器并盖到该记录上，
// 保证“看到远端后再做的改动”版本一定更高，从而不依赖系统时钟就能正确定序。
function nextVer() {
  store.clock = (store.clock || 0) + 1
  return store.clock
}

// 谁更新：版本高者胜；版本相同再比修改时间；再相同比 uid，保证结果确定。
function recNewer(a, b) {
  const av = a.ver || 0, bv = b.ver || 0
  if (av !== bv) return av > bv
  const at = String(a.updated_at || ''), bt = String(b.updated_at || '')
  if (at !== bt) return at > bt
  return String(a.uid || '') > String(b.uid || '')
}

// 墓碑是否压过记录：删除版本高者胜；同版本删除优先（>=）。
function deleteWins(tombVer, tombAt, recVer, recAt) {
  const tv = tombVer || 0, rv = recVer || 0
  if (tv !== rv) return tv > rv
  return String(tombAt || '') >= String(recAt || '')
}

function normTags(tags) {
  if (Array.isArray(tags)) {
    return [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))]
  }
  if (typeof tags === 'string') {
    return [...new Set(tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean))]
  }
  return []
}

// 去掉 HTML 标签和 base64 图片，得到纯文本（用于搜索和摘要）
function toText(html) {
  return String(html || '')
    .replace(/<img[^>]*>/gi, ' [图片] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function clean(data) {
  return {
    title: String((data && data.title) || '').trim() || '未命名',
    body: String((data && data.body) || ''),
    tags: normTags(data && data.tags),
    attachments: normAttachments(data && data.attachments)
  }
}

// ---------------------------------------------------------------------------
// 附件（任意文件）
// 正文里的图片仍是 base64 内嵌；附件则按「内容哈希」单独存成文件，记录里只留元数据。
// 同一个文件被多条笔记引用只占一份磁盘，且 git 同步只为新文件增加体积——
// 不像内嵌 base64 那样每改一次就要重写、重传一整份变大的 JSON。
// 记录字段：attachments: [{ file, name, size, added_at }]，file = <sha256><扩展名>
// ---------------------------------------------------------------------------
const ATTACH_DIR_NAME = 'attachments'
const MAX_ATTACH_BYTES = 20 * 1024 * 1024   // 单个附件上限 20MB：再大会拖垮 git 同步

// file 字段可能来自同步/导入的数据，绝不能直接拿去拼路径：只认「64 位十六进制哈希
// + 可选短扩展名」，其余一律拒绝，杜绝 ..\ 之类路径穿越读写到任意位置。
const ATTACH_FILE_RE = /^[0-9a-f]{64}(\.[a-z0-9]{1,16})?$/

// 一键打开的黑名单：附件可能来自同步/导入，shell.openPath 对可执行文件等于直接运行它。
// 这类文件只允许「另存为」，由用户自己决定要不要执行，应用绝不代劳。
const RISKY_EXT = new Set([
  '.exe', '.com', '.scr', '.pif', '.bat', '.cmd', '.msi', '.msp', '.msc',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta',
  '.reg', '.lnk', '.jar', '.cpl', '.dll', '.sh'
])

// 本次会话新加的附件可能还没写进记录（用户还在编辑），GC 必须跳过它们，
// 否则会把编辑中引用的文件当孤儿清掉。
const pinnedAttach = new Set()

function attachPath(file) {
  const f = String(file || '')
  if (!attachDir || !ATTACH_FILE_RE.test(f)) return ''
  return join(attachDir, f)
}

// 展示/另存用的文件名：去掉路径分隔符与控制字符，纯点的名字（. ..）也要换掉，
// 保证它拼进任何目录都只是一个普通文件名。
function safeName(name) {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180)
  return /^\.*$/.test(s) ? '' : s
}

function normAttachments(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const a of list) {
    if (!a || typeof a !== 'object') continue
    const file = String(a.file || '')
    if (!ATTACH_FILE_RE.test(file) || seen.has(file)) continue
    seen.add(file)
    out.push({
      file,
      name: safeName(a.name) || file,
      size: Number(a.size) > 0 ? Math.floor(Number(a.size)) : 0,
      added_at: String(a.added_at || '')
    })
  }
  return out
}

// 把外部文件收进附件库：同内容只存一份（文件名就是内容 sha256）
function addAttachmentFromPath(srcPath) {
  const p = String(srcPath || '')
  if (!p || !existsSync(p)) return { ok: false, error: '文件不存在或无法访问' }
  const st = statSync(p)
  if (st.isDirectory()) return { ok: false, error: `${basename(p)} 是文件夹，请先打包成压缩包` }
  if (st.size > MAX_ATTACH_BYTES) {
    return { ok: false, error: `${basename(p)} 超过 ${MAX_ATTACH_BYTES / 1048576} MB 上限` }
  }
  const buf = readFileSync(p)
  const hash = createHash('sha256').update(buf).digest('hex')
  const ext = extname(p).toLowerCase()
  const file = ATTACH_FILE_RE.test(hash + ext) ? hash + ext : hash
  mkdirSync(attachDir, { recursive: true })
  const dest = join(attachDir, file)
  if (!existsSync(dest)) writeFileSync(dest, buf)
  pinnedAttach.add(file)
  return {
    ok: true,
    item: { file, name: safeName(basename(p)) || file, size: st.size, added_at: now() }
  }
}

// 逐个收，个别失败（超限/无权限）不影响其它文件，错误如实回给界面
function addAttachments(paths) {
  const items = []
  const errors = []
  for (const p of (Array.isArray(paths) ? paths : [])) {
    const r = addAttachmentFromPath(p)
    if (r.ok) items.push(r.item)
    else errors.push(r.error)
  }
  return { ok: items.length > 0, items, errors }
}

async function pickAttachments() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择要添加的附件',
    properties: ['openFile', 'multiSelections']
  })
  if (canceled || !filePaths.length) return { ok: false, items: [], errors: [] }
  return addAttachments(filePaths)
}

async function openAttachment(file, name) {
  const src = attachPath(file)
  if (!src || !existsSync(src)) return { ok: false, error: '附件文件缺失（可能还没同步到本机）' }
  const nice = safeName(name) || String(file)
  if (RISKY_EXT.has(extname(nice).toLowerCase()) || RISKY_EXT.has(extname(src).toLowerCase())) {
    return { ok: false, error: '这类文件可能被直接运行，请用「另存为」保存后自行打开' }
  }
  try {
    // 先用原始文件名复制到临时目录再打开：附件本体是哈希命名的，直接打开会满屏乱码文件名。
    // 临时副本仅供查看，在里面的改动不会回写附件本体。
    const dir = join(app.getPath('temp'), 'workrecoder-open')
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, nice)
    copyFileSync(src, dest)
    const err = await shell.openPath(dest)
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function saveAttachmentAs(file, name) {
  const src = attachPath(file)
  if (!src || !existsSync(src)) return { ok: false, error: '附件文件缺失（可能还没同步到本机）' }
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '另存附件',
    defaultPath: safeName(name) || String(file)
  })
  if (canceled || !filePath) return { ok: false }
  try {
    copyFileSync(src, filePath)
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 所有记录都不再引用的附件文件 = 孤儿，回收磁盘。
// 只在「记录集合整体变过」的时机调用（启动/删除/导入/同步），不放在每次保存里，
// 免得每保存一次就扫一遍目录；编辑中产生的孤儿会在下次启动时清掉。
function gcAttachments() {
  try {
    if (!attachDir || !existsSync(attachDir)) return
    const used = new Set(pinnedAttach)
    for (const r of store.records) {
      for (const a of r.attachments || []) used.add(a.file)
    }
    for (const f of readdirSync(attachDir)) {
      if (used.has(f) || !ATTACH_FILE_RE.test(f)) continue  // 非本程序管理的文件不动
      try { unlinkSync(join(attachDir, f)) } catch { /* 被占用则下次再清 */ }
    }
  } catch { /* 回收失败无伤大雅，不影响功能 */ }
}

// ---- 记录操作 ----
function listRecords({ q = '', tag = '' } = {}) {
  let list = store.records.map((r) => ({ ...r, text: toText(r.body) }))
  if (tag) list = list.filter((r) => (r.tags || []).includes(tag))
  if (q) {
    const kw = q.toLowerCase()
    list = list.filter((r) =>
      r.title.toLowerCase().includes(kw) ||
      r.text.toLowerCase().includes(kw) ||
      (r.tags || []).some((t) => t.toLowerCase().includes(kw))
    )
  }
  list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  // 返回给列表用的摘要，不回传完整 body（省内存；编辑时单独取）
  return list.map((r) => ({
    id: r.id,
    title: r.title,
    tags: r.tags || [],
    snippet: r.text.slice(0, 160),
    hasImage: /<img/i.test(r.body || ''),
    hasAttach: (r.attachments || []).length > 0,
    created_at: r.created_at,
    updated_at: r.updated_at
  }))
}

function getRecord(id) {
  const r = store.records.find((x) => x.id === id)
  if (!r) return null
  // 附件本体可能还没同步到本机（只拉到了元数据），告知界面好标出「缺失」
  const attachments = (r.attachments || []).map((a) => {
    const p = attachPath(a.file)
    return { ...a, missing: !p || !existsSync(p) }
  })
  return { ...r, attachments }
}

function createRecord(data) {
  const c = clean(data)
  const ts = now()
  const full = { id: store.nextId++, uid: randomUUID(), ...c, created_at: ts, updated_at: ts, ver: nextVer() }
  store.records.push(full)
  saveStore()
  return full.id
}

function updateRecord(id, data) {
  const rec = store.records.find((r) => r.id === id)
  if (!rec) return false
  Object.assign(rec, clean(data), { updated_at: now(), ver: nextVer() })
  saveStore()
  return true
}

function addTombstone(uid) {
  if (!uid) return
  const ts = now()
  const v = nextVer()
  const existing = store.deleted.find((d) => d.uid === uid)
  if (existing) { existing.deleted_at = ts; existing.ver = v }
  else store.deleted.push({ uid, deleted_at: ts, ver: v })
}

function deleteRecord(id) {
  const rec = store.records.find((r) => r.id === id)
  if (rec) addTombstone(rec.uid) // 记墓碑，删除才能在合并时传播
  store.records = store.records.filter((r) => r.id !== id)
  saveStore()
  gcAttachments() // 该记录独占的附件随之回收
  return true
}

// 所有用到过的标签（并集），按使用频次降序
function listTags() {
  const count = new Map()
  for (const r of store.records) {
    for (const t of r.tags || []) count.set(t, (count.get(t) || 0) + 1)
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => ({ name, count: n }))
}

// ---- 导出 / 导入 ----
// JSON 备份把附件本体（base64）一并带走，否则「备份」就不再是完整备份。
// 只影响导出/导入，不影响启动/保存/同步这些热路径；总量超上限则只导元数据并如实告知，
// 避免生成一个大到解析不动的 JSON。
const EXPORT_BLOB_CAP = 150 * 1024 * 1024

function collectBlobs() {
  const blobs = {}
  let total = 0
  let skipped = 0
  for (const r of store.records) {
    for (const a of r.attachments || []) {
      if (blobs[a.file] !== undefined) continue // 同内容只导一份
      const p = attachPath(a.file)
      if (!p || !existsSync(p)) { skipped++; continue }
      const size = statSync(p).size
      if (total + size > EXPORT_BLOB_CAP) { skipped++; continue }
      total += size
      try { blobs[a.file] = readFileSync(p).toString('base64') } catch { skipped++ }
    }
  }
  return { blobs, skipped }
}

// 还原备份里的附件本体。key 必须是合法的哈希命名，且内容哈希要对得上：
// 备份文件是外部输入，不能让它把任意内容写成任意附件。
function restoreBlobs(blobs) {
  if (!blobs || typeof blobs !== 'object') return 0
  mkdirSync(attachDir, { recursive: true })
  let n = 0
  for (const [file, b64] of Object.entries(blobs)) {
    const p = attachPath(file)
    if (!p || existsSync(p)) continue
    try {
      const buf = Buffer.from(String(b64), 'base64')
      if (createHash('sha256').update(buf).digest('hex') !== file.split('.')[0]) continue
      writeFileSync(p, buf)
      pinnedAttach.add(file)
      n++
    } catch { /* 单个附件失败不影响其它 */ }
  }
  return n
}

function exportSnapshot() {
  const { blobs, skipped } = collectBlobs()
  return {
    snapshot: {
      app: 'WorkRecoder',
      version: 3,
      exported_at: now(),
      clock: store.clock,
      records: store.records,
      deleted: store.deleted,
      blobs
    },
    skipped
  }
}

function toCsv() {
  const cols = ['id', 'title', 'tags', 'text', 'attachments', 'created_at', 'updated_at']
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [cols.join(',')]
  for (const r of store.records) {
    lines.push([
      r.id, r.title, (r.tags || []).join(' '), toText(r.body),
      (r.attachments || []).map((a) => a.name).join(' | '),
      r.created_at, r.updated_at
    ].map(esc).join(','))
  }
  return '﻿' + lines.join('\r\n')
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

// 把外部备份文件解析成 store 形态（补全 uid/ver、并入旧版账号密码字段、带上墓碑），
// 之后统一走 mergeStores 与本机合并——与「同步」同一套语义，避免导入独有的边角 bug。
function buildImportedStore(data) {
  const out = { records: [], nextId: 1, deleted: [], clock: Number(data && data.clock) || 0 }
  const records = data && Array.isArray(data.records) ? data.records : []
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.body != null) {
      // 新版备份：保留时间戳/版本；缺 uid 的用内容派生（同一文件重复导入结果一致）
      const c = clean(rec)
      const created = rec.created_at || now()
      out.records.push({
        id: 0,
        uid: rec.uid || stableUid({ created_at: rec.created_at || '', title: c.title, body: c.body }),
        title: c.title,
        body: c.body,
        tags: c.tags,
        attachments: c.attachments,
        created_at: created,
        updated_at: rec.updated_at || created,
        ver: (typeof rec.ver === 'number' && isFinite(rec.ver)) ? rec.ver : 1
      })
    } else {
      // 旧版记录（账号/密码/链接/分类）→ 合并进正文；uid 由原始字段派生（重复导入不会重复）
      const parts = []
      if (rec.url) parts.push(`链接：${rec.url}`)
      if (rec.username) parts.push(`账号：${rec.username}`)
      if (rec.password) parts.push(`密码：${rec.password}`)
      if (rec.content) parts.push(rec.content)
      const body = parts.map((p) => `<p>${escapeHtml(p)}</p>`).join('')
      const tags = normTags(rec.tags)
      if (rec.category) tags.push(rec.category)
      const c = clean({ title: rec.title, body, tags: normTags(tags) })
      const created = rec.created_at || now()
      out.records.push({
        id: 0,
        uid: stableUid({ created_at: rec.created_at || '', title: c.title, body: c.body }),
        title: c.title,
        body: c.body,
        tags: c.tags,
        created_at: created,
        updated_at: rec.updated_at || created,
        ver: 1
      })
    }
  }
  if (Array.isArray(data && data.deleted)) {
    for (const d of data.deleted) {
      if (!d || !d.uid) continue
      out.deleted.push({
        uid: d.uid,
        deleted_at: String(d.deleted_at || now()),
        ver: (typeof d.ver === 'number' && isFinite(d.ver)) ? d.ver : 1
      })
    }
  }
  return out
}

function importData(data) {
  const before = new Set(store.records.map((r) => r.uid))
  const imported = buildImportedStore(data)
  // 附件本体先落盘，再合并元数据，避免中间状态里出现「有引用无文件」
  restoreBlobs(data && data.blobs)
  // 落盘前备份本机（导入现在也会应用墓碑，可能删除记录）
  if (existsSync(dataFile)) {
    try { copyFileSync(dataFile, dataFile + '.before-import-' + Date.now() + '.json') } catch { /* 备份失败也继续 */ }
  }
  store = mergeStores(store, imported)
  saveStore()
  gcAttachments() // 导入会应用墓碑删记录，需重新回收孤儿附件
  let added = 0
  for (const r of store.records) if (!before.has(r.uid)) added++
  return added
}

// ---------------------------------------------------------------------------
// 同步到私有 git 仓库（SSH + 系统 git；双向；明文）
// 配置存 workrecoder-sync.json（不同步），数据经 sync-repo 目录与远端交互。
// 上传 = 本机覆盖云端；下载 = 云端覆盖本机（下载前自动备份本机）。
// ---------------------------------------------------------------------------
const SYNC_FILE = 'workrecoder-data.json' // 仓库内的数据文件名
const SYNC_ATTACH_DIR = 'attachments'     // 仓库内的附件目录

// 当前记录集实际引用到的附件文件名集合——同步两个方向都以它为准
function referencedAttachFiles() {
  const s = new Set()
  for (const r of store.records) {
    for (const a of r.attachments || []) s.add(a.file)
  }
  return s
}

// 把本机附件镜像到 sync-repo：被引用的补上，已没任何记录引用的从仓库删掉。
// 不删的话云端体积只涨不降，且死文件会被各机器反复拉回本地。
// 注意：“被引用但本机还没有”的文件只能跳过（keep 已保护它不被删），
// 否则会把另一台机器刚传上去、本机尚未拉取的附件误删。
function mirrorAttachmentsToRepo() {
  const destDir = join(syncDir, SYNC_ATTACH_DIR)
  mkdirSync(destDir, { recursive: true })
  const keep = referencedAttachFiles()
  for (const f of readdirSync(destDir)) {
    if (!ATTACH_FILE_RE.test(f) || keep.has(f)) continue
    try { unlinkSync(join(destDir, f)) } catch { /* 删不掉下次再说 */ }
  }
  for (const f of keep) {
    const src = attachPath(f)
    if (!src || !existsSync(src)) continue
    const dest = join(destDir, f)
    if (!existsSync(dest)) {
      try { copyFileSync(src, dest) } catch { /* 单个拷贝失败不中断整体 */ }
    }
  }
}

// 从仓库补齐本机缺的附件，但只拉「当前记录集确实引用」的，
// 避免把已被删除的死文件一次次拷回来再被 GC 删掉。
// 因此必须在 loadStore()/mergeStores() 之后调用，store 已是最终记录集。
function pullNeededAttachments() {
  const srcDir = join(syncDir, SYNC_ATTACH_DIR)
  if (!existsSync(srcDir)) return
  mkdirSync(attachDir, { recursive: true })
  for (const f of referencedAttachFiles()) {
    const dest = attachPath(f)
    if (!dest || existsSync(dest)) continue
    const src = join(srcDir, f)
    if (!existsSync(src)) continue
    try { copyFileSync(src, dest) } catch { /* 单个拷贝失败不中断整体 */ }
  }
}

function runGit(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: opts.cwd || syncDir,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      // 超时兜底：任何 git 操作卡住（如 HTTPS 弹凭据 GUI、网络挂起）最多等 120 秒即被杀掉，
      // 不会让「同步」按钮永久转圈。
      timeout: opts.timeout || 120000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        // 非交互：不弹密码、首次连接自动接受 host key
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
        // 彻底关掉凭据交互（HTTPS 地址时避免 Windows 凭据管理器弹窗把进程挂死）
        GCM_INTERACTIVE: 'never',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.interactive', GIT_CONFIG_VALUE_0: 'false',
        GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: ''
      }
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      })
    })
  })
}

function readSyncConfig() {
  const def = { repoUrl: '', branch: 'main' }
  try {
    if (existsSync(syncConfigFile)) {
      const cfg = JSON.parse(readFileSync(syncConfigFile, 'utf-8'))
      return {
        repoUrl: String(cfg.repoUrl || '').trim(),
        branch: String(cfg.branch || 'main').trim() || 'main'
      }
    }
  } catch { /* 配置损坏则退回默认 */ }
  return def
}

function writeSyncConfig(cfg) {
  const out = {
    repoUrl: String((cfg && cfg.repoUrl) || '').trim(),
    branch: String((cfg && cfg.branch) || 'main').trim() || 'main'
  }
  const tmp = syncConfigFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8')
  renameSync(tmp, syncConfigFile)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 同步状态（列表页右上角的状态灯）
// 判据只用本地数据：store.clock 每次新建/编辑/删除都会 +1（删除也推进），
// 合并/下载后取两边较大值。因此「上次成功同步时记下的 clock == 当前 clock」
// 就等价于「本机没有尚未推送的改动」，无需联网 fetch 即可判断。
// ---------------------------------------------------------------------------
function readSyncState() {
  const def = { lastSyncedClock: -1, lastSyncAt: '' }
  try {
    if (existsSync(syncStateFile)) {
      const s = JSON.parse(readFileSync(syncStateFile, 'utf-8'))
      const n = Number(s.lastSyncedClock)
      return { lastSyncedClock: isFinite(n) ? n : -1, lastSyncAt: String(s.lastSyncAt || '') }
    }
  } catch { /* 状态文件损坏就当从未同步过 */ }
  return def
}

function markSynced() {
  try {
    const out = { lastSyncedClock: Number(store.clock) || 0, lastSyncAt: now() }
    const tmp = syncStateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8')
    renameSync(tmp, syncStateFile)
  } catch { /* 写不了状态只影响状态灯，不影响同步本身 */ }
}

// git 可用性只探一次：状态灯每次刷新都会问，每次都起一个 git 进程太重
let gitOkCache = null
async function gitAvailable(force) {
  if (force || gitOkCache === null) {
    const r = await runGit(['--version'], { cwd: app.getPath('userData') })
    gitOkCache = r.ok
  }
  return gitOkCache
}

async function syncStatusInfo() {
  const cfg = readSyncConfig()
  const st = readSyncState()
  return {
    configured: !!cfg.repoUrl,
    gitAvailable: await gitAvailable(false),
    synced: !!cfg.repoUrl && !!st.lastSyncAt && st.lastSyncedClock === (Number(store.clock) || 0),
    lastSyncAt: st.lastSyncAt
  }
}

// 用于 commit 的固定身份（避免目标机器没有全局 git 身份时 commit 失败）
const GIT_IDENTITY = ['-c', 'user.email=workrecoder@local', '-c', 'user.name=WorkRecoder']

async function ensureRepo(repoUrl, branch) {
  mkdirSync(syncDir, { recursive: true })
  if (!existsSync(join(syncDir, '.git'))) {
    let r = await runGit(['init'])
    if (!r.ok) return { ok: false, error: 'git init 失败：' + r.stderr }
    r = await runGit(['checkout', '-B', branch])
    if (!r.ok) return { ok: false, error: r.stderr }
    r = await runGit(['remote', 'add', 'origin', repoUrl])
    if (!r.ok) return { ok: false, error: r.stderr }
  } else {
    // 地址可能改过，始终对齐
    await runGit(['remote', 'remove', 'origin'])
    const r = await runGit(['remote', 'add', 'origin', repoUrl])
    if (!r.ok) return { ok: false, error: r.stderr }
  }
  return { ok: true }
}

// 记录级三方合并：按 uid 认身份，同 uid 取「版本较高」者（recNewer，版本相同再比时间/uid）；
// 墓碑按版本压制记录（deleteWins）。整数 id 仅本地句柄，合并后按 created_at 重排，
// 避免两台机器各自 nextId++ 产生的 id 撞车。clock 取两边较大并覆盖到所有见过的版本。
function mergeStores(local, remote) {
  const recs = [
    ...(Array.isArray(local && local.records) ? local.records : []),
    ...(Array.isArray(remote && remote.records) ? remote.records : [])
  ]
  const dels = [
    ...(Array.isArray(local && local.deleted) ? local.deleted : []),
    ...(Array.isArray(remote && remote.deleted) ? remote.deleted : [])
  ]

  // 墓碑并集：同 uid 取版本较高（同版本取较晚删除时间）
  const tomb = new Map() // uid -> { ver, at }
  for (const d of dels) {
    if (!d || !d.uid) continue
    const cand = { ver: d.ver || 0, at: String(d.deleted_at || '') }
    const cur = tomb.get(d.uid)
    if (!cur || cand.ver > cur.ver || (cand.ver === cur.ver && cand.at > cur.at)) tomb.set(d.uid, cand)
  }

  // 记录并集：同 uid 取较新（缺 uid 的用 legacy-<id> 兜底，理论上不会发生）
  const byUid = new Map()
  for (const r of recs) {
    if (!r || typeof r !== 'object') continue
    const uid = r.uid || ('legacy-' + r.id)
    const cand = { ...r, uid }
    const cur = byUid.get(uid)
    if (!cur || recNewer(cand, cur)) byUid.set(uid, cand)
  }

  // 应用墓碑：删除版本压过记录 → 删除胜出；否则记录（含被“编辑复活”的）保留
  const alive = []
  for (const [uid, r] of byUid) {
    const t = tomb.get(uid)
    if (t && deleteWins(t.ver, t.at, r.ver, r.updated_at)) continue
    alive.push(r)
  }

  // 清理已被复活的墓碑，避免其永久压制该记录
  const aliveUids = new Set(alive.map((r) => r.uid))
  const deleted = []
  for (const [uid, t] of tomb) {
    if (!aliveUids.has(uid)) deleted.push({ uid, deleted_at: t.at, ver: t.ver })
  }

  // Lamport 时钟：两边较大，再覆盖到所有存活记录/墓碑的版本
  let clock = Math.max(Number(local && local.clock) || 0, Number(remote && remote.clock) || 0)
  for (const r of alive) clock = Math.max(clock, r.ver || 0)
  for (const d of deleted) clock = Math.max(clock, d.ver || 0)

  // 重排本地整数 id（按创建时间稳定排序）
  alive.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  let nid = 1
  const records = alive.map((r) => ({
    id: nid++,
    uid: r.uid,
    title: String(r.title || '未命名'),
    body: String(r.body || ''),
    tags: normTags(r.tags),
    attachments: normAttachments(r.attachments),
    created_at: r.created_at || now(),
    updated_at: r.updated_at || now(),
    ver: r.ver || 1
  }))
  return { records, nextId: nid, deleted, clock }
}

async function syncUpload() {
  try {
    const { repoUrl, branch } = readSyncConfig()
    if (!repoUrl) return { ok: false, error: '请先设置仓库地址' }
    const ready = await ensureRepo(repoUrl, branch)
    if (!ready.ok) return ready

    if (!existsSync(dataFile)) saveStore() // 保证有数据文件
    copyFileSync(dataFile, join(syncDir, SYNC_FILE))
    mirrorAttachmentsToRepo() // 附件一并推上去（本机已删的同时从仓库清掉）

    let r = await runGit(['add', '-A'])
    if (!r.ok) return { ok: false, error: r.stderr }
    // 有暂存改动才提交（diff --cached --quiet：退出码 1 = 有改动）。提交失败要报错，
    // 不能吞掉后当成功——否则会 force 推送一份没带上本次改动的旧 HEAD。
    const staged = await runGit(['diff', '--cached', '--quiet'])
    if (staged.code === 1) {
      const commit = await runGit([...GIT_IDENTITY, 'commit', '-m', `sync ${hostname()} ${now()}`])
      if (!commit.ok) return { ok: false, error: '提交失败：' + (commit.stderr || commit.stdout || '').trim() }
    }

    r = await runGit(['push', '--force', 'origin', `HEAD:${branch}`])
    if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || '推送失败').trim() }
    markSynced() // 记下已推送到的本地时钟，右上角状态灯据此变绿
    return { ok: true, message: '已上传到仓库' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function syncDownload() {
  try {
    const { repoUrl, branch } = readSyncConfig()
    if (!repoUrl) return { ok: false, error: '请先设置仓库地址' }
    const ready = await ensureRepo(repoUrl, branch)
    if (!ready.ok) return ready

    let r = await runGit(['fetch', 'origin', branch])
    if (!r.ok) {
      // 分支不存在或无权限/地址错误
      const msg = (r.stderr || '拉取失败').trim()
      // 只把“分支/引用不存在”当作云端为空；"Repository not found"（地址错/无权限）要如实报错
      if (/couldn't find remote ref|no such ref/i.test(msg)) {
        return { ok: false, error: '云端还没有数据，请先在另一台电脑点上传' }
      }
      return { ok: false, error: msg }
    }
    r = await runGit(['rev-parse', '--verify', `origin/${branch}`])
    if (!r.ok) return { ok: false, error: '云端还没有数据，请先在另一台电脑点上传' }

    r = await runGit(['reset', '--hard', `origin/${branch}`])
    if (!r.ok) return { ok: false, error: r.stderr }

    const incoming = join(syncDir, SYNC_FILE)
    if (!existsSync(incoming)) {
      return { ok: false, error: '仓库里没有 workrecoder-data.json，本机数据未改动' }
    }
    // 覆盖前备份本机
    if (existsSync(dataFile)) {
      try { renameSync(dataFile, dataFile + '.before-download-' + Date.now() + '.json') } catch { /* 备份失败也继续 */ }
    }
    copyFileSync(incoming, dataFile)
    loadStore() // 重新载入内存
    pullNeededAttachments() // store 已是云端记录集，此时才能判定该拉哪些附件
    gcAttachments() // 清理无人引用的附件
    markSynced() // 已与云端一致
    return { ok: true, message: '已从仓库下载' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 同步互斥：三个同步操作共用一个 sync-repo 目录与 git 索引，并发会撞 index.lock。
// 主进程侧兜底串行化（渲染层的 syncBusy 只是第一道防线）。
let syncInFlight = false
async function withSyncLock(fn) {
  if (syncInFlight) return { ok: false, error: '正在同步中，请稍候…' }
  syncInFlight = true
  try {
    return await fn()
  } finally {
    syncInFlight = false
  }
}

// 合并同步：拉远端 → 按记录合并 → 推回。两台机器各自随便改都不丢。
async function syncMerge() {
  try {
    const { repoUrl, branch } = readSyncConfig()
    if (!repoUrl) return { ok: false, error: '请先设置仓库地址' }
    const ready = await ensureRepo(repoUrl, branch)
    if (!ready.ok) return ready

    // 判断远端分支是否已有内容
    const fetched = await runGit(['fetch', 'origin', branch])
    let remoteExists = false
    if (fetched.ok) {
      const rev = await runGit(['rev-parse', '--verify', `origin/${branch}`])
      remoteExists = rev.ok
    } else {
      const msg = (fetched.stderr || '').trim()
      // 仅“分支/引用不存在”按“远端为空”处理；"Repository not found"（地址错/无权限）等要如实报错
      const benign = /couldn't find remote ref|no such ref|remote HEAD refers to nonexistent/i.test(msg)
      if (!benign) return { ok: false, error: msg || 'fetch 失败' }
    }

    if (remoteExists) {
      // 把工作区对齐到远端，读远端数据
      let r = await runGit(['reset', '--hard', `origin/${branch}`])
      if (!r.ok) return { ok: false, error: r.stderr }
      const incoming = join(syncDir, SYNC_FILE)
      let remoteStore = { records: [], nextId: 1, deleted: [] }
      if (existsSync(incoming)) {
        try { remoteStore = JSON.parse(readFileSync(incoming, 'utf-8')) } catch { /* 远端损坏当空 */ }
      }
      const merged = mergeStores(store, remoteStore)
      // 落盘前备份本机
      if (existsSync(dataFile)) {
        try { copyFileSync(dataFile, dataFile + '.before-merge-' + Date.now() + '.json') } catch { /* 备份失败也继续 */ }
      }
      store = merged
      saveStore()
      // 先按合并后的记录集拉齐远端附件（含对方新增的），再把本机镜像回仓库，
      // 顺序不能颠倒：镜像会删掉仓库里无人引用的文件，必须建立在合并结果上。
      pullNeededAttachments()
      copyFileSync(dataFile, incoming)
      mirrorAttachmentsToRepo()
      gcAttachments()
    } else {
      // 远端为空：以本机为初始内容（此时 HEAD 已在本地 init 的空分支上）
      mkdirSync(syncDir, { recursive: true })
      if (!existsSync(dataFile)) saveStore()
      copyFileSync(dataFile, join(syncDir, SYNC_FILE))
      mirrorAttachmentsToRepo()
    }

    let r = await runGit(['add', '-A'])
    if (!r.ok) return { ok: false, error: r.stderr }
    // 有暂存改动才提交（diff --cached --quiet 退出码 1 = 有改动）；提交失败要如实报错
    const staged = await runGit(['diff', '--cached', '--quiet'])
    if (staged.code === 1) {
      const commit = await runGit([...GIT_IDENTITY, 'commit', '-m', `merge ${hostname()} ${now()}`])
      if (!commit.ok) return { ok: false, error: '提交失败：' + (commit.stderr || commit.stdout || '').trim() }
    }
    // 合并后本地提交是 origin 的子提交（或全新分支），普通推送即可，不用 force
    r = await runGit(['push', 'origin', `HEAD:${branch}`])
    if (!r.ok) {
      const msg = (r.stderr || r.stdout || '推送失败').trim()
      if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
        return { ok: false, error: '远端在你同步期间又更新了，请再点一次「同步」' }
      }
      return { ok: false, error: msg }
    }
    markSynced() // 合并结果已推送成功，本机改动全部上云
    return { ok: true, message: '已合并同步' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 用系统默认浏览器打开链接。仅放行 http/https/mailto——笔记正文可能来自同步/导入，
// 绝不能让 file:// 之类协议被系统当程序/资源打开。
function openExternalUrl(url) {
  try {
    const u = String(url || '').trim()
    if (!/^(https?:|mailto:)/i.test(u)) return { ok: false, error: '不支持的链接类型' }
    shell.openExternal(u)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('shell:openExternal', (_e, url) => openExternalUrl(url))
  ipcMain.handle('records:list', (_e, filter) => listRecords(filter || {}))
  ipcMain.handle('records:get', (_e, id) => getRecord(id))
  ipcMain.handle('records:create', (_e, data) => createRecord(data))
  ipcMain.handle('records:update', (_e, id, data) => updateRecord(id, data))
  ipcMain.handle('records:delete', (_e, id) => deleteRecord(id))
  ipcMain.handle('tags:list', () => listTags())

  // ---- 附件 ----
  ipcMain.handle('attach:pick', () => pickAttachments())
  // 拖拽进来的文件：渲染层拿不到真实路径（Electron 32+ 移除了 File.path），
  // 由 preload 的 webUtils 换出路径后交给这里收录
  ipcMain.handle('attach:addPaths', (_e, paths) => addAttachments(paths))
  ipcMain.handle('attach:open', (_e, file, name) => openAttachment(file, name))
  ipcMain.handle('attach:saveAs', (_e, file, name) => saveAttachmentAs(file, name))
  // 删除编辑中还未保存的附件仅需在前端从列表里拿掉；未被引用的文件下次 gc 时自然会被清。

  ipcMain.handle('data:exportJson', async () => {
    const stamp = now().replace(/[-: ]/g, '').slice(0, 14)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出备份',
      defaultPath: `worklog_backup_${stamp}.json`,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { ok: false }
    const { snapshot, skipped } = exportSnapshot()
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
    return { ok: true, path: filePath, skipped }
  })

  ipcMain.handle('data:exportCsv', async () => {
    const stamp = now().replace(/[-: ]/g, '').slice(0, 14)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出 CSV',
      defaultPath: `worklog_${stamp}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { ok: false }
    writeFileSync(filePath, toCsv(), 'utf-8')
    return { ok: true, path: filePath }
  })

  // ---- 私有仓库同步 ----
  ipcMain.handle('sync:getConfig', async () => {
    const cfg = readSyncConfig()
    // 打开设置窗时强制重探一次：用户可能刚装好 git
    return { ...cfg, gitAvailable: await gitAvailable(true) }
  })
  ipcMain.handle('sync:setConfig', (_e, cfg) => writeSyncConfig(cfg))
  ipcMain.handle('sync:status', () => syncStatusInfo())
  ipcMain.handle('sync:merge', () => withSyncLock(syncMerge))
  ipcMain.handle('sync:upload', () => withSyncLock(syncUpload))
  ipcMain.handle('sync:download', () => withSyncLock(syncDownload))

  // 关窗前让渲染层保存当前正在编辑的笔记，收到 flush-done 后才真正关闭
  ipcMain.on('app:flush-done', () => {
    allowClose = true
    if (mainWin && !mainWin.isDestroyed()) mainWin.close()
  })

  ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择 JSON 备份文件导入',
      properties: ['openFile'],
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    })
    if (canceled || !filePaths[0]) return { ok: false }
    try {
      const data = JSON.parse(readFileSync(filePaths[0], 'utf-8'))
      const added = importData(data)
      return { ok: true, added }
    } catch {
      return { ok: false, error: '文件不是有效的 JSON 备份' }
    }
  })
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
let mainWin = null
let allowClose = false

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 720,
    minHeight: 480,
    title: '工作记录本',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 链接一律交给系统默认浏览器，绝不在应用窗口里打开/跳转：
  // window.open（如 target=_blank）→ 拦下并用系统浏览器
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  // 应用窗口本身想跳到外部地址 → 拦下并用系统浏览器（放行本地渲染页自身的导航）
  mainWin.webContents.on('will-navigate', (e, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl && url.startsWith(rendererUrl)) return // 开发模式：本地页面内部导航
    if (url.startsWith('file://')) return                   // 打包后：本地 index.html
    e.preventDefault()
    openExternalUrl(url)
  })

  // 正文图片（data: 开头的 base64 内嵌图）右键菜单：复制图片 / 图片另存为
  mainWin.webContents.on('context-menu', (_e, params) => {
    if (!params.hasImageContents || typeof params.srcURL !== 'string') return
    if (!params.srcURL.startsWith('data:image/')) return

    // 把 dataURL 还原成图片；解析失败则只保留「另存为」
    let img = null
    try { img = nativeImage.createFromDataURL(params.srcURL) } catch { img = null }
    const imgOk = img && !img.isEmpty()

    const menu = Menu.buildFromTemplate([
      {
        label: '复制图片',
        enabled: imgOk,
        click: () => { clipboard.writeImage(img) }
      },
      {
        label: '图片另存为…',
        click: async () => {
          const m = /^data:image\/([a-z0-9+.-]+);/i.exec(params.srcURL)
          const ext = (m && m[1].toLowerCase().replace('jpeg', 'jpg')) || 'png'
          const { canceled, filePath } = await dialog.showSaveDialog({
            title: '图片另存为',
            defaultPath: `image_${now().replace(/[-: ]/g, '').slice(0, 14)}.${ext}`
          })
          if (canceled || !filePath) return
          try {
            const buf = Buffer.from(params.srcURL.slice(params.srcURL.indexOf(',') + 1), 'base64')
            writeFileSync(filePath, buf)
          } catch { /* 写盘失败静默：与导出等路径一致，不打扰编辑 */ }
        }
      }
    ])
    menu.popup()
  })

  // 关闭前先让渲染层保存正在编辑的内容，避免未点「返回并保存」就丢失
  mainWin.on('close', (e) => {
    if (allowClose) return
    e.preventDefault()
    mainWin.webContents.send('app:before-close')
    // 兜底：渲染层若无响应（崩溃等），3 秒后强制关闭
    setTimeout(() => {
      allowClose = true
      if (mainWin && !mainWin.isDestroyed()) mainWin.close()
    }, 3000)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWin.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWin.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  loadStore()
  gcAttachments() // 启动时清一次孤儿附件
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
