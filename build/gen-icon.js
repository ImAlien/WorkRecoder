// 生成应用图标（纯 Node，无原生依赖）：蓝底圆角 + 白色记事本页面 + 蓝色文字线
// 输出 build/icon.png（256x256 RGBA）和 build/icon.ico
// 重新生成：node build/gen-icon.js
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')

const W = 256, H = 256
const buf = Buffer.alloc(W * H * 4) // 全透明

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
}

// 圆角矩形填充（不透明覆盖，256px 下硬边缘足够清晰）
function fillRoundRect(X, Y, RW, RH, R, col) {
  for (let y = Y; y < Y + RH; y++) {
    for (let x = X; x < X + RW; x++) {
      const cx = x < X + R ? X + R : (x > X + RW - 1 - R ? X + RW - 1 - R : x)
      const cy = y < Y + R ? Y + R : (y > Y + RH - 1 - R ? Y + RH - 1 - R : y)
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy <= R * R) setPx(x, y, col[0], col[1], col[2], col[3])
    }
  }
}

const BLUE = [37, 99, 235, 255]   // 主题蓝 #2563eb
const WHITE = [255, 255, 255, 255]

// 1) 蓝色圆角底
fillRoundRect(8, 8, 240, 240, 44, BLUE)
// 2) 白色页面
fillRoundRect(68, 44, 120, 168, 14, WHITE)
// 3) 页面上的蓝色文字线
fillRoundRect(88, 82, 80, 12, 6, BLUE)
fillRoundRect(88, 112, 80, 12, 6, BLUE)
fillRoundRect(88, 142, 80, 12, 6, BLUE)
fillRoundRect(88, 172, 50, 12, 6, BLUE)

// ---- PNG 编码 ----
function crc32(b) {
  if (!crc32.t) {
    const t = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    crc32.t = t
  }
  let crc = 0xffffffff
  for (let i = 0; i < b.length; i++) crc = crc32.t[(crc ^ b[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8bit RGBA
const stride = 1 + W * 4
const raw = Buffer.alloc(H * stride)
for (let y = 0; y < H; y++) {
  raw[y * stride] = 0 // filter: none
  buf.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4)
}
const idat = zlib.deflateSync(raw, { level: 9 })
const png = Buffer.concat([
  sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
])

// ---- ICO 封装（单张 256x256 PNG）----
const head = Buffer.alloc(6)
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0        // 256x256, 无调色板
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6)         // planes, bpp
entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12)
const ico = Buffer.concat([head, entry, png])

const dir = __dirname
fs.writeFileSync(path.join(dir, 'icon.png'), png)
fs.writeFileSync(path.join(dir, 'icon.ico'), ico)
console.log('icon.png', png.length, 'bytes / icon.ico', ico.length, 'bytes')
