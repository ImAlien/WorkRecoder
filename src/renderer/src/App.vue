<script setup>
import { ref, computed, onMounted } from 'vue'
import NoteEditor from './NoteEditor.vue'

const view = ref('list')        // 'list' | 'edit'
const records = ref([])
const tags = ref([])            // [{name,count}]
const query = ref('')
const activeTag = ref('')
const toastMsg = ref('')
const editingNote = ref(null)
const editorRef = ref(null)

let searchTimer = null
let toastTimer = null

const countText = computed(() => {
  if (query.value || activeTag.value) return `找到 ${records.value.length} 条`
  return `共 ${records.value.length} 条记录`
})

function toast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = ''), 1500)
}

async function refresh() {
  records.value = await window.api.listRecords({
    q: query.value.trim(),
    tag: activeTag.value
  })
}
async function loadTags() {
  tags.value = await window.api.listTags()
}
async function reloadAll() {
  await Promise.all([refresh(), loadTags()])
}

function onSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(refresh, 180)
}

function toggleTag(name) {
  activeTag.value = activeTag.value === name ? '' : name
  refresh()
}

// ---- 打开编辑器 ----
function openNew() {
  editingNote.value = { id: null, title: '', body: '', tags: activeTag.value ? [activeTag.value] : [] }
  view.value = 'edit'
}
async function openEdit(id) {
  const full = await window.api.getRecord(id)
  if (!full) { toast('记录不存在'); await reloadAll(); return }
  editingNote.value = { id: full.id, title: full.title, body: full.body, tags: full.tags || [] }
  view.value = 'edit'
}

async function onSave(payload) {
  if (payload.id != null) await window.api.updateRecord(payload.id, payload)
  else await window.api.createRecord(payload)
  view.value = 'list'
  editingNote.value = null
  await reloadAll()
  toast('已保存')
}
function onCancel() {
  view.value = 'list'
  editingNote.value = null
}
async function onDelete(id) {
  await window.api.deleteRecord(id)
  view.value = 'list'
  editingNote.value = null
  await reloadAll()
  toast('已删除')
}

// ---- 导出 / 导入 ----
async function exportJson() {
  const r = await window.api.exportJson()
  if (r.ok) toast('已导出备份')
}
async function exportCsv() {
  const r = await window.api.exportCsv()
  if (r.ok) toast('已导出 CSV')
}
async function importData() {
  const r = await window.api.importData()
  if (r.ok) { toast(`已导入 ${r.added} 条记录`); await reloadAll() }
  else if (r.error) toast(r.error)
}

// 关窗前：若正在编辑，先保存当前笔记，再通知主进程可以关闭了
async function onBeforeClose() {
  try {
    if (view.value === 'edit' && editorRef.value) await editorRef.value.flushSave()
  } finally {
    window.api.flushDone()
  }
}

onMounted(() => {
  window.api.onBeforeClose(onBeforeClose)
  reloadAll()
})
</script>

<template>
  <!-- 列表视图 -->
  <div v-if="view === 'list'" class="list-view">
    <header>
      <h1>📒 工作记录本</h1>
      <div class="search">
        <input v-model="query" @input="onSearch" placeholder="搜索标题 / 正文 / 标签…" />
      </div>
      <button @click="openNew">+ 新建笔记</button>
      <button class="ghost" @click="exportJson" title="导出为 JSON 备份文件">导出</button>
      <button class="ghost" @click="exportCsv" title="导出为 CSV（Excel 可打开）">导出CSV</button>
      <button class="ghost" @click="importData" title="从 JSON 备份导入">导入</button>
    </header>

    <div class="tagrow" v-if="tags.length">
      <span class="chip filter" :class="{ on: activeTag === '' }" @click="toggleTag('')">全部</span>
      <span v-for="t in tags" :key="t.name" class="chip filter"
            :class="{ on: activeTag === t.name }" @click="toggleTag(t.name)">
        # {{ t.name }} <em>{{ t.count }}</em>
      </span>
    </div>

    <main>
      <div class="count">{{ countText }}</div>

      <div v-if="records.length === 0" class="empty">
        {{ query || activeTag ? '没有匹配的记录' : '还没有笔记，点右上角「新建笔记」开始吧' }}
      </div>

      <div class="grid">
        <div v-for="rec in records" :key="rec.id" class="card" @click="openEdit(rec.id)">
          <div class="card-title">
            <span v-if="rec.hasImage" class="img-badge">🖼</span>{{ rec.title }}
          </div>
          <div class="card-snippet">{{ rec.snippet || '（空）' }}</div>
          <div class="card-tags" v-if="rec.tags.length">
            <span v-for="t in rec.tags" :key="t" class="chip mini"># {{ t }}</span>
          </div>
          <div class="card-meta">{{ rec.updated_at }}</div>
        </div>
      </div>
    </main>
  </div>

  <!-- 编辑视图 -->
  <NoteEditor v-else ref="editorRef" :key="editingNote.id ?? 'new'" :note="editingNote" :all-tags="tags"
              @save="onSave" @cancel="onCancel" @delete="onDelete" />

  <transition name="fade">
    <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
  </transition>
</template>

<style scoped>
.list-view { min-height: 100vh; }
header {
  position: sticky; top: 0; z-index: 10; background: var(--card);
  border-bottom: 1px solid var(--line); padding: 12px 20px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
header h1 { font-size: 18px; margin: 0 8px 0 0; white-space: nowrap; }
.search { flex: 1; min-width: 200px; }
.search input { width: 100%; }

.tagrow {
  position: sticky; top: 57px; z-index: 9; background: var(--bg);
  display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 20px 4px;
}
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--tag-bg); color: var(--tag-tx);
  padding: 3px 10px; border-radius: 20px; font-size: 13px;
}
.chip.filter { cursor: pointer; background: #eceef1; color: var(--muted); }
.chip.filter:hover { background: #e0e2e6; }
.chip.filter.on { background: var(--primary); color: #fff; }
.chip.filter em { font-style: normal; opacity: .7; font-size: 11px; }
.chip.mini { font-size: 11px; padding: 1px 8px; }

main { max-width: 1000px; margin: 0 auto; padding: 12px 20px 24px; }
.count { color: var(--muted); margin: 8px 0 12px; }
.empty { text-align: center; color: var(--muted); padding: 60px 0; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 16px; cursor: pointer; transition: box-shadow .15s, transform .05s;
  display: flex; flex-direction: column; min-height: 120px;
}
.card:hover { box-shadow: 0 4px 16px rgba(0,0,0,.08); }
.card:active { transform: scale(.995); }
.card-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; word-break: break-all;
  display: flex; align-items: center; gap: 4px; }
.img-badge { font-size: 12px; }
.card-snippet {
  color: var(--muted); font-size: 13px; line-height: 1.5; flex: 1;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
}
.card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.card-meta { color: #9ca3af; font-size: 11px; margin-top: 8px; }

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: #111827; color: #fff; padding: 8px 16px; border-radius: 8px; z-index: 200;
}
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
