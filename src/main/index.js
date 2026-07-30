import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs'

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
let store = { records: [], nextId: 1 }

function loadStore() {
  dataFile = join(app.getPath('userData'), 'workrecoder-data.json')
  if (existsSync(dataFile)) {
    try {
      store = JSON.parse(readFileSync(dataFile, 'utf-8'))
    } catch {
      // 数据文件损坏：绝不静默丢弃。先把损坏文件改名保留，再从空存储开始，
      // 这样后续写入不会覆盖掉原始（可能可人工恢复的）数据。
      const backup = dataFile + '.corrupt-' + Date.now() + '.json'
      try { renameSync(dataFile, backup) } catch { /* 改名失败也不覆盖原文件 */ }
      store = { records: [], nextId: 1 }
    }
  } else {
    store = { records: [], nextId: 1 }
    saveStore()
  }
  if (!Array.isArray(store.records)) store.records = []
  // 兼容/规整
  store.records.forEach((r) => { r.tags = normTags(r.tags) })
  if (!store.nextId) {
    store.nextId = store.records.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1
  }
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
    tags: normTags(data && data.tags)
  }
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
    created_at: r.created_at,
    updated_at: r.updated_at
  }))
}

function getRecord(id) {
  const r = store.records.find((x) => x.id === id)
  return r ? { ...r } : null
}

function createRecord(data) {
  const c = clean(data)
  const ts = now()
  const full = { id: store.nextId++, ...c, created_at: ts, updated_at: ts }
  store.records.push(full)
  saveStore()
  return full.id
}

function updateRecord(id, data) {
  const rec = store.records.find((r) => r.id === id)
  if (!rec) return false
  Object.assign(rec, clean(data), { updated_at: now() })
  saveStore()
  return true
}

function deleteRecord(id) {
  store.records = store.records.filter((r) => r.id !== id)
  saveStore()
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
function exportSnapshot() {
  return {
    app: 'WorkRecoder',
    version: 2,
    exported_at: now(),
    records: store.records
  }
}

function toCsv() {
  const cols = ['id', 'title', 'tags', 'text', 'created_at', 'updated_at']
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [cols.join(',')]
  for (const r of store.records) {
    lines.push([
      r.id, r.title, (r.tags || []).join(' '), toText(r.body),
      r.created_at, r.updated_at
    ].map(esc).join(','))
  }
  return '﻿' + lines.join('\r\n')
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

function importData(data) {
  let added = 0
  const records = data && Array.isArray(data.records) ? data.records : []
  const existingIds = new Set(store.records.map((r) => r.id))
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.body != null) {
      // 新版备份：忠实还原——保留原始 id 与时间戳，按 id 去重（跳过已存在）
      const id = Number(rec.id)
      if (Number.isFinite(id) && existingIds.has(id)) continue
      const c = clean(rec)
      const useId = Number.isFinite(id) && !existingIds.has(id) ? id : store.nextId++
      store.records.push({
        id: useId,
        title: c.title,
        body: c.body,
        tags: c.tags,
        created_at: rec.created_at || now(),
        updated_at: rec.updated_at || now()
      })
      existingIds.add(useId)
      added++
    } else {
      // 旧版记录（账号/密码/链接/分类）→ 合并进正文，分配新 id
      const parts = []
      if (rec.url) parts.push(`链接：${rec.url}`)
      if (rec.username) parts.push(`账号：${rec.username}`)
      if (rec.password) parts.push(`密码：${rec.password}`)
      if (rec.content) parts.push(rec.content)
      const body = parts.map((p) => `<p>${escapeHtml(p)}</p>`).join('')
      const tags = normTags(rec.tags)
      if (rec.category) tags.push(rec.category)
      const c = clean({ title: rec.title, body, tags: normTags(tags) })
      const ts = now()
      const id = store.nextId++
      store.records.push({ id, ...c, created_at: ts, updated_at: ts })
      existingIds.add(id)
      added++
    }
  }
  // 重算 nextId，保证后续新建不会撞上导入进来的 id
  store.nextId = store.records.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1
  saveStore()
  return added
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('records:list', (_e, filter) => listRecords(filter || {}))
  ipcMain.handle('records:get', (_e, id) => getRecord(id))
  ipcMain.handle('records:create', (_e, data) => createRecord(data))
  ipcMain.handle('records:update', (_e, id, data) => updateRecord(id, data))
  ipcMain.handle('records:delete', (_e, id) => deleteRecord(id))
  ipcMain.handle('tags:list', () => listTags())

  ipcMain.handle('data:exportJson', async () => {
    const stamp = now().replace(/[-: ]/g, '').slice(0, 14)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出备份',
      defaultPath: `worklog_backup_${stamp}.json`,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { ok: false }
    writeFileSync(filePath, JSON.stringify(exportSnapshot(), null, 2), 'utf-8')
    return { ok: true, path: filePath }
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
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
