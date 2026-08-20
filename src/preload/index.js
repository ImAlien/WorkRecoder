import { contextBridge, ipcRenderer, webUtils } from 'electron'

// 只把安全的、白名单内的方法暴露给渲染进程
const api = {
  listRecords: (filter) => ipcRenderer.invoke('records:list', filter),
  getRecord: (id) => ipcRenderer.invoke('records:get', id),
  createRecord: (data) => ipcRenderer.invoke('records:create', data),
  updateRecord: (id, data) => ipcRenderer.invoke('records:update', id, data),
  deleteRecord: (id) => ipcRenderer.invoke('records:delete', id),
  listTags: () => ipcRenderer.invoke('tags:list'),

  // 附件：本体存在 %APPDATA%\workrecoder\attachments，记录里只存元数据
  pickAttachments: () => ipcRenderer.invoke('attach:pick'),
  addAttachments: (paths) => ipcRenderer.invoke('attach:addPaths', paths),
  openAttachment: (file, name) => ipcRenderer.invoke('attach:open', file, name),
  saveAttachmentAs: (file, name) => ipcRenderer.invoke('attach:saveAs', file, name),
  // 拖拽进来的 File 在渲染层拿不到真实路径（Electron 32+ 去掉了 File.path），
  // 只能在 preload 里用 webUtils 换取
  getFilePath: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },

  exportJson: () => ipcRenderer.invoke('data:exportJson'),
  exportCsv: () => ipcRenderer.invoke('data:exportCsv'),
  importData: () => ipcRenderer.invoke('data:import'),

  // 用系统默认浏览器打开链接（Ctrl/⌘ + 单击时调用）
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // 私有仓库同步
  syncGetConfig: () => ipcRenderer.invoke('sync:getConfig'),
  syncSetConfig: (cfg) => ipcRenderer.invoke('sync:setConfig', cfg),
  syncMerge: () => ipcRenderer.invoke('sync:merge'),
  syncUpload: () => ipcRenderer.invoke('sync:upload'),
  syncDownload: () => ipcRenderer.invoke('sync:download'),

  // 关窗前保存钩子：主进程发 before-close，渲染层保存完调用 flushDone
  onBeforeClose: (cb) => ipcRenderer.on('app:before-close', () => cb()),
  flushDone: () => ipcRenderer.send('app:flush-done')
}

contextBridge.exposeInMainWorld('api', api)
