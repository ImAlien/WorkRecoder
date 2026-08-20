<script setup>
import { ref, reactive, watch, onBeforeUnmount } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'

const props = defineProps({
  note: { type: Object, required: true },   // {id, title, body, tags, attachments}
  allTags: { type: Array, default: () => [] } // [{name,count}]
})
const emit = defineEmits(['save', 'cancel', 'delete', 'notify'])

const title = ref(props.note.title || '')
const tags = reactive([...(props.note.tags || [])])
// 附件元数据：[{ file, name, size, added_at, missing }]。file 是内容哈希，本体由主进程存盘。
const attachments = reactive([...(props.note.attachments || [])])
const tagInput = ref('')
const fileInput = ref(null)

// 打开时预填的标签（如从标签筛选进入新建）。判空时要忽略它们，
// 否则一条什么都没写、只带着预填标签的新笔记会被当成「非空」而留下垃圾记录。
const initialTags = [...(props.note.tags || [])]

// 记录进行中的图片插入（粘贴/拖拽是异步的）。保存前必须等它们完成，否则会丢图。
const pendingInserts = new Set()

// 是否有过实际改动。关窗自动保存时用它避免「只是打开看看」也被写回、白白刷新时间戳。
const dirty = ref(false)
watch(title, () => { dirty.value = true })

// 把图片文件转成 base64，并把过大的图片等比缩到最长边 1600，控制数据体积
function processImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new window.Image()
      img.onload = () => {
        const MAX = 1600
        let { width, height } = img
        if (width > MAX || height > MAX) {
          const s = Math.min(MAX / width, MAX / height)
          width = Math.round(width * s)
          height = Math.round(height * s)
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        // png 保留（截图文字清晰），其它转 jpeg 压缩
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
        resolve(canvas.toDataURL(type, 0.9))
      }
      img.onerror = () => resolve(reader.result)
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

function insertImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return
  const p = processImage(file)
    .then((dataUrl) => { editor.value?.chain().focus().setImage({ src: dataUrl }).run() })
    .catch(() => {})
    .finally(() => pendingInserts.delete(p))
  pendingInserts.add(p)
  return p
}

// 等所有进行中的图片插入落地，供保存/关窗前调用
async function flushPending() {
  if (pendingInserts.size) await Promise.allSettled([...pendingInserts])
}

const editor = useEditor({
  content: props.note.body || '',
  onUpdate: () => { dirty.value = true },
  extensions: [
    // 链接：关掉「单击即打开」——单击只把光标放进去，方便编辑；
    // 真正打开改由下方 handleClick 在 Ctrl/⌘ + 单击时走系统默认浏览器。
    StarterKit.configure({
      link: { openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } }
    }),
    Image.configure({ inline: false, allowBase64: true }),
    Placeholder.configure({ placeholder: '开始记录…（账号密码、步骤、链接都写这里，可粘贴/插入截图）' }),
    TaskList,
    TaskItem.configure({ nested: true })
  ],
  editorProps: {
    // 单击链接：默认什么都不做（放光标）；Ctrl/⌘ + 单击才用系统默认浏览器打开
    handleClick(view, pos, event) {
      const a = event.target && event.target.closest && event.target.closest('a[href]')
      if (a && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        const href = a.getAttribute('href')
        if (href) window.api.openExternal(href)
        return true
      }
      return false
    },
    handlePaste(view, event) {
      const items = event.clipboardData?.items || []
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const file = it.getAsFile()
          if (file) { insertImageFile(file); return true }
        }
      }
      return false
    },
    handleDrop(view, event) {
      const files = [...(event.dataTransfer?.files || [])]
      if (!files.length) return false
      const images = files.filter((f) => f.type.startsWith('image/'))
      const others = files.filter((f) => !f.type.startsWith('image/'))
      // 图片照旧内嵌进正文；其它文件一律当附件收下
      images.forEach((f) => insertImageFile(f))
      if (others.length) addFiles(others)
      event.preventDefault()
      return true
    }
  }
})

onBeforeUnmount(() => editor.value?.destroy())

// ---- 标签 ----
function addTag(name) {
  const t = String(name || tagInput.value).trim()
  if (t && !tags.includes(t)) { tags.push(t); dirty.value = true }
  tagInput.value = ''
}
function removeTag(t) {
  const i = tags.indexOf(t)
  if (i >= 0) { tags.splice(i, 1); dirty.value = true }
}
function onTagKey(e) {
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
    e.preventDefault()
    addTag()
  } else if (e.key === 'Backspace' && !tagInput.value && tags.length) {
    tags.pop()
    dirty.value = true
  }
}

// 未选中的、可点击补充的已有标签
function suggestions() {
  return props.allTags.map((t) => t.name).filter((n) => !tags.includes(n)).slice(0, 12)
}

// ---- 图片按钮 ----
function pickImage() { fileInput.value?.click() }
function onFilePicked(e) {
  const f = e.target.files[0]
  if (f) insertImageFile(f)
  e.target.value = ''
}

// ---- 附件 ----
function fmtSize(n) {
  const b = Number(n) || 0
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}

// 把新收录的附件并入列表（同一个 file 不重复挂）
function mergeItems(items) {
  let n = 0
  for (const it of items || []) {
    if (attachments.some((a) => a.file === it.file)) continue
    attachments.push({ ...it, missing: false })
    n++
  }
  if (n) dirty.value = true
  return n
}

// 拖拽进来的 File → 真实路径（靠 preload 的 webUtils）→ 主进程收录
async function addFiles(files) {
  const paths = files.map((f) => window.api.getFilePath(f)).filter(Boolean)
  if (!paths.length) { emit('notify', '无法读取文件路径，请用「📎 附件」按钮选择'); return }
  const r = await window.api.addAttachments(paths)
  reportAdd(r)
}

async function pickAttachments() {
  const r = await window.api.pickAttachments()
  reportAdd(r)
}

// 超限/无权限等失败要如实告知，不能默默丢掉用户拖进来的文件
function reportAdd(r) {
  if (!r) return
  const n = mergeItems(r.items)
  const errs = r.errors || []
  if (errs.length) emit('notify', errs[0] + (errs.length > 1 ? ` 等 ${errs.length} 个文件未添加` : ''))
  else if (n) emit('notify', `已添加 ${n} 个附件`)
}

async function openAttachment(a) {
  const r = await window.api.openAttachment(a.file, a.name)
  if (!r.ok && r.error) emit('notify', r.error)
}
async function saveAttachmentAs(a) {
  const r = await window.api.saveAttachmentAs(a.file, a.name)
  if (r.ok) emit('notify', '已另存')
  else if (r.error) emit('notify', r.error)
}
function removeAttachment(a) {
  const i = attachments.indexOf(a)
  if (i >= 0) { attachments.splice(i, 1); dirty.value = true }
}

// ---- 关闭 / 保存 ----
// 只带着预填标签、没手动改过标签时，视作没动过标签
function tagsUntouched() {
  return tags.length === initialTags.length && tags.every((t) => initialTags.includes(t))
}
function isEmpty() {
  if (pendingInserts.size) return false   // 有图片正在插入，不算空
  if (attachments.length) return false    // 只挂了附件也是内容，不能当空笔记丢掉
  const body = editor.value?.getHTML() || ''
  const textEmpty = editor.value ? editor.value.getText().trim() === '' && !/<img/i.test(body) : true
  return !title.value.trim() && textEmpty && tagsUntouched()
}

function payload() {
  return {
    id: props.note.id,
    title: title.value,
    body: editor.value?.getHTML() || '',
    tags: [...tags],
    // 只传主进程认的字段（missing 是界面标记，不入库）
    attachments: attachments.map((a) => ({
      file: a.file, name: a.name, size: a.size, added_at: a.added_at
    }))
  }
}

async function done() {
  await flushPending()                     // 等粘贴/拖拽的图片插入完成，避免丢图
  if (props.note.id == null && isEmpty()) { emit('cancel'); return }
  emit('save', payload())
}

// 关窗前调用：直接落盘（不走导航），空的新笔记或没改过的笔记则跳过
async function flushSave() {
  await flushPending()
  if (props.note.id == null && isEmpty()) return
  if (!dirty.value) return                 // 只是打开看了看，没动过，不写回
  const p = payload()
  if (p.id != null) await window.api.updateRecord(p.id, p)
  else await window.api.createRecord(p)
}
defineExpose({ flushSave })

function del() {
  if (props.note.id == null) { emit('cancel'); return }
  if (confirm(`确定删除「${title.value || '未命名'}」？此操作不可撤销。`)) emit('delete', props.note.id)
}

const isActive = (name, attrs) => editor.value?.isActive(name, attrs)
</script>

<template>
  <div class="editor-view">
    <div class="topbar">
      <button class="ghost" @click="done">‹ 返回并保存</button>
      <div class="spacer"></div>
      <button v-if="note.id != null" class="ghost danger" @click="del">删除</button>
    </div>

    <div class="toolbar" v-if="editor">
      <button :class="{ on: isActive('heading', { level: 1 }) }"
              @click="editor.chain().focus().toggleHeading({ level: 1 }).run()" title="标题">H1</button>
      <button :class="{ on: isActive('heading', { level: 2 }) }"
              @click="editor.chain().focus().toggleHeading({ level: 2 }).run()" title="小标题">H2</button>
      <span class="sep"></span>
      <button :class="{ on: isActive('bold') }"
              @click="editor.chain().focus().toggleBold().run()" title="加粗"><b>B</b></button>
      <button :class="{ on: isActive('italic') }"
              @click="editor.chain().focus().toggleItalic().run()" title="斜体"><i>I</i></button>
      <button :class="{ on: isActive('strike') }"
              @click="editor.chain().focus().toggleStrike().run()" title="删除线"><s>S</s></button>
      <span class="sep"></span>
      <button :class="{ on: isActive('bulletList') }"
              @click="editor.chain().focus().toggleBulletList().run()" title="无序列表">• 列表</button>
      <button :class="{ on: isActive('orderedList') }"
              @click="editor.chain().focus().toggleOrderedList().run()" title="有序列表">1. 列表</button>
      <button :class="{ on: isActive('taskList') }"
              @click="editor.chain().focus().toggleTaskList().run()" title="待办清单">☑ 待办</button>
      <button :class="{ on: isActive('codeBlock') }"
              @click="editor.chain().focus().toggleCodeBlock().run()" title="代码块">&lt;/&gt;</button>
      <span class="sep"></span>
      <button @click="pickImage" title="插入图片">🖼 插图</button>
      <button @click="pickAttachments" title="添加附件（任意文件，也可拖拽到正文）">📎 附件</button>
    </div>

    <div class="paper">
      <input class="note-title" v-model="title" placeholder="标题" />
      <EditorContent :editor="editor" class="note-body" />
    </div>

    <div class="attachbar" v-if="attachments.length">
      <div class="attach-head">
        <span class="tag-label">📎 附件 ({{ attachments.length }})</span>
      </div>
      <div class="attach-list">
        <div v-for="a in attachments" :key="a.file" class="attach-item" :class="{ missing: a.missing }">
          <span class="a-name" :title="a.missing ? '文件本体还没同步到本机' : a.name"
                @click="!a.missing && openAttachment(a)">
            <span class="a-icon">{{ a.missing ? '⚠️' : '📄' }}</span>{{ a.name }}
          </span>
          <span class="a-size">{{ a.missing ? '未同步' : fmtSize(a.size) }}</span>
          <button class="a-btn" v-if="!a.missing" @click="saveAttachmentAs(a)" title="另存为…">⇩</button>
          <button class="a-btn x" @click="removeAttachment(a)" title="从此笔记移除">×</button>
        </div>
      </div>
    </div>

    <div class="tagbar">
      <span class="tag-label">标签</span>
      <span v-for="t in tags" :key="t" class="chip">
        {{ t }} <span class="x" @click="removeTag(t)">×</span>
      </span>
      <input class="tag-input" v-model="tagInput" @keydown="onTagKey"
             list="allTagList" placeholder="输入后回车添加，可多个" autocomplete="off" />
      <datalist id="allTagList">
        <option v-for="t in allTags" :key="t.name" :value="t.name" />
      </datalist>
    </div>
    <div class="tag-suggest" v-if="suggestions().length">
      <span class="hint">已有标签：</span>
      <span v-for="s in suggestions()" :key="s" class="chip pick" @click="addTag(s)">+ {{ s }}</span>
    </div>

    <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onFilePicked" />
  </div>
</template>

<style scoped>
.editor-view { display: flex; flex-direction: column; height: 100vh; background: #fff; }
.topbar {
  display: flex; align-items: center; padding: 10px 16px;
  border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.spacer { flex: 1; }
.ghost.danger { color: var(--danger); }
.ghost.danger:hover { background: #fee2e2; }

.toolbar {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: 8px 16px; border-bottom: 1px solid var(--line);
  background: #fafbfc; flex-shrink: 0;
}
.toolbar button {
  background: transparent; color: var(--text); padding: 5px 9px;
  border-radius: 6px; font-size: 13px; min-width: 30px;
}
.toolbar button:hover { background: #eceef1; }
.toolbar button.on { background: var(--primary); color: #fff; }
.sep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; }

.paper { flex: 1; overflow-y: auto; padding: 24px clamp(20px, 8vw, 100px); }
.note-title {
  border: none; outline: none; width: 100%; font-size: 26px; font-weight: 700;
  padding: 0 0 8px; margin-bottom: 8px; color: var(--text);
}

.tagbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.tag-label { color: var(--muted); font-size: 13px; margin-right: 4px; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--tag-bg); color: var(--tag-tx);
  padding: 3px 10px; border-radius: 20px; font-size: 13px;
}
.chip .x { cursor: pointer; font-weight: 700; opacity: .6; }
.chip .x:hover { opacity: 1; }
.chip.pick { cursor: pointer; background: #f0f1f3; color: var(--muted); }
.chip.pick:hover { background: var(--tag-bg); color: var(--tag-tx); }
.tag-input { border: none; outline: none; flex: 1; min-width: 140px; padding: 4px; }
.tag-suggest { padding: 0 16px 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.tag-suggest .hint { color: var(--muted); font-size: 12px; }

.attachbar { padding: 10px 16px 0; border-top: 1px solid var(--line); flex-shrink: 0; }
.attach-head { margin-bottom: 6px; }
.attach-list { display: flex; flex-direction: column; gap: 4px; }
.attach-item {
  display: flex; align-items: center; gap: 8px;
  background: #f6f7f9; border: 1px solid var(--line); border-radius: 8px;
  padding: 6px 10px; font-size: 13px;
}
.attach-item.missing { background: #fef8f2; border-color: #f0d8b8; }
.a-name {
  flex: 1; min-width: 0; cursor: pointer; color: var(--primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: flex; align-items: center; gap: 6px;
}
.attach-item.missing .a-name { cursor: default; color: #b45309; }
.a-name:hover { text-decoration: underline; }
.attach-item.missing .a-name:hover { text-decoration: none; }
.a-icon { flex-shrink: 0; }
.a-size { color: var(--muted); font-size: 12px; white-space: nowrap; }
.a-btn {
  background: transparent; border: none; cursor: pointer; color: var(--muted);
  font-size: 15px; padding: 2px 6px; border-radius: 6px; line-height: 1;
}
.a-btn:hover { background: #e6e8eb; color: var(--text); }
.a-btn.x:hover { background: #fee2e2; color: var(--danger); }
</style>

<style>
/* Tiptap 正文（非 scoped，作用到 ProseMirror 生成的内容） */
.note-body .ProseMirror { outline: none; min-height: 300px; font-size: 15px; line-height: 1.75; color: var(--text); }
.note-body .ProseMirror > * + * { margin-top: 0.75em; }
.note-body .ProseMirror h1 { font-size: 22px; font-weight: 700; }
.note-body .ProseMirror h2 { font-size: 18px; font-weight: 700; }
.note-body .ProseMirror ul, .note-body .ProseMirror ol { padding-left: 1.4em; }
.note-body .ProseMirror img { max-width: 100%; border-radius: 8px; margin: 6px 0; display: block; }
.note-body .ProseMirror img.ProseMirror-selectednode { outline: 3px solid var(--primary); }
.note-body .ProseMirror pre {
  background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 12px 14px;
  font-family: Consolas, Menlo, monospace; font-size: 13px; overflow-x: auto;
}
.note-body .ProseMirror code { font-family: Consolas, Menlo, monospace; }
.note-body .ProseMirror a {
  color: var(--primary); text-decoration: underline; cursor: pointer;
}
/* 悬停时提示：Ctrl/⌘ + 单击用系统浏览器打开 */
.note-body .ProseMirror a:hover { text-decoration: underline; opacity: .85; }
.note-body .ProseMirror ul[data-type="taskList"] { list-style: none; padding-left: 0.2em; }
.note-body .ProseMirror ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
.note-body .ProseMirror ul[data-type="taskList"] li > label { margin-top: 4px; }
.note-body .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder); color: #9ca3af; float: left; height: 0; pointer-events: none;
}
</style>
