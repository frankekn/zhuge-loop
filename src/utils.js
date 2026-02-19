import fs from 'node:fs/promises'
import path from 'node:path'

export function nowIso() {
  return new Date().toISOString()
}

export function timestampForPath(isoString = nowIso()) {
  return isoString.replace(/[:]/g, '-').replace(/\..+$/, 'Z')
}

export async function mkdirp(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

export async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export async function writeJson(filePath, obj) {
  await mkdirp(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

export async function appendText(filePath, line) {
  await mkdirp(path.dirname(filePath))
  await fs.appendFile(filePath, line, 'utf8')
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function resolveFrom(basePath, maybeRelativePath) {
  if (!maybeRelativePath) return basePath
  if (path.isAbsolute(maybeRelativePath)) return maybeRelativePath
  return path.resolve(basePath, maybeRelativePath)
}

export function truncate(text, limit = 200_000) {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n...[truncated at ${limit} chars]\n`
}
