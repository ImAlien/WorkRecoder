import { contextBridge, ipcRenderer } from 'electron'

// 只把安全的、白名单内的方法暴露给渲染进程
const api = {
  listRecords: (filter) => ipcRenderer.invoke('records:list', filter),
  getRecord: (id) => ipcRenderer.invoke('records:get', id),
  createRecord: (data) => ipcRenderer.invoke('records:create', data),
  updateRecord: (id, data) => ipcRenderer.invoke('records:update', id, data),
  deleteRecord: (id) => ipcRenderer.invoke('records:delete', id),
  listTags: () => ipcRenderer.invoke('tags:list'),

  exportJson: () => ipcRenderer.invoke('data:exportJson'),
  exportCsv: () => ipcRenderer.invoke('data:exportCsv'),
  importData: () => ipcRenderer.invoke('data:import'),

  // 关窗前保存钩子：主进程发 before-close，渲染层保存完调用 flushDone
  onBeforeClose: (cb) => ipcRenderer.on('app:before-close', () => cb()),
  flushDone: () => ipcRenderer.send('app:flush-done')
}

contextBridge.exposeInMainWorld('api', api)
