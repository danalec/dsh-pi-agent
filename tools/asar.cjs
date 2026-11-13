#!/usr/bin/env node
// Minimal asar reader: list paths and extract file contents.
// usage: node asar.cjs list <asar> [prefix]
//        node asar.cjs get  <asar> <path-in-asar>
const fs = require('node:fs')
const path = require('node:path')

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const base = 8 + head.readUInt32LE(4)
  const headerSize = head.readUInt32LE(12)
  const buf = Buffer.alloc(headerSize)
  fs.readSync(fd, buf, 0, headerSize, 16)
  fs.closeSync(fd)
  return { header: JSON.parse(buf.toString('utf8')), base }
}

function walk(files, prefix, out) {
  for (const [name, entry] of Object.entries(files)) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry.files, p, out)
    else if (!entry.unpacked && entry.offset !== undefined) {
      out.push({ path: p, size: entry.size, offset: entry.offset })
    }
  }
  return out
}

const [cmd, asar, ...rest] = process.argv.slice(2)
const { header, base } = readHeader(asar)
const entries = walk(header.files, '', [])

if (cmd === 'list') {
  const prefix = rest[0] || ''
  for (const e of entries) {
    if (!prefix || e.path.includes(prefix)) console.log(`${e.size}\t${e.path}`)
  }
} else if (cmd === 'get') {
  const target = rest[0]
  const e = entries.find(x => x.path === target)
  if (!e) { console.error('not found:', target); process.exit(1) }
  const fd = fs.openSync(asar, 'r')
  const buf = Buffer.alloc(e.size)
  fs.readSync(fd, buf, 0, e.size, base + Number(e.offset))
  fs.closeSync(fd)
  process.stdout.write(buf)
} else if (cmd === 'grep') {
  const pattern = new RegExp(rest[0])
  const list = rest[1] ? rest[1].split('|') : null
  for (const e of entries) {
    if (!e.path.endsWith('.js') && !e.path.endsWith('.mjs') && !e.path.endsWith('.cjs')) continue
    if (list && !list.some(l => e.path.includes(l))) continue
    const fd = fs.openSync(asar, 'r')
    const buf = Buffer.alloc(e.size)
    fs.readSync(fd, buf, 0, e.size, base + Number(e.offset))
    fs.closeSync(fd)
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (pattern.test(line)) console.log(`${e.path}:${i + 1}: ${line.trim().slice(0, 300)}`)
    })
  }
}
