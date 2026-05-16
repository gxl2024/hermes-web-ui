import { readdir, readFile } from 'fs/promises'
import { dirname, join, relative, resolve } from 'path'
import { createHash } from 'crypto'
import {
  readConfigYaml, updateConfigYaml,
  safeReadFile, extractDescription, listFilesRecursive, getHermesDir,
} from '../../services/config-helpers'
import { pinSkill } from '../../services/hermes/hermes-cli'
import { getSkillUsageStatsFromDb } from '../../db/hermes/sessions-db'

/** Read bundled manifest as a name-to-hash map from ~/.hermes/skills/.bundled_manifest */
function readBundledManifest(manifestContent: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!manifestContent) return map
  for (const line of manifestContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const name = trimmed.slice(0, idx).trim()
    const hash = trimmed.slice(idx + 1).trim()
    if (name && hash) map.set(name, hash)
  }
  return map
}

/** Read hub-installed skill names from ~/.hermes/skills/.hub/lock.json */
function readHubInstalledNames(lockContent: string | null): Set<string> {
  if (!lockContent) return new Set()
  try {
    const data = JSON.parse(lockContent)
    if (data?.installed && typeof data.installed === 'object') {
      return new Set(Object.keys(data.installed))
    }
  } catch { /* ignore */ }
  return new Set()
}

/** Compute md5 hash of all files in a directory (mirrors Hermes _dir_hash), with in-memory cache */
const hashCache = new Map<string, { hash: string; mtime: number }>()
const HASH_CACHE_TTL = 60_000 // 1 minute

async function dirHash(directory: string): Promise<string> {
  const cached = hashCache.get(directory)
  if (cached && Date.now() - cached.mtime < HASH_CACHE_TTL) return cached.hash

  const hasher = createHash('md5')
  const files = await listFilesRecursive(directory, '')
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  for (const f of files) {
    hasher.update(f.path)
    const content = await readFile(join(directory, f.path))
    hasher.update(content)
  }
  const hash = hasher.digest('hex')
  hashCache.set(directory, { hash, mtime: Date.now() })
  return hash
}

/** Determine the source type of a skill */
function getSkillSource(
  skillName: string,
  bundledManifest: Map<string, string>,
  hubNames: Set<string>,
): 'builtin' | 'hub' | 'local' {
  if (bundledManifest.has(skillName)) return 'builtin'
  if (hubNames.has(skillName)) return 'hub'
  return 'local'
}

/** Read .usage.json as a name-to-stats map */
interface UsageStats { patch_count: number; use_count: number; view_count: number; pinned: boolean }
function readUsageStats(usageContent: string | null): Map<string, UsageStats> {
  const map = new Map<string, UsageStats>()
  if (!usageContent) return map
  try {
    const data = JSON.parse(usageContent)
    for (const [name, stats] of Object.entries(data)) {
      const s = stats as any
      map.set(name, { patch_count: s.patch_count ?? 0, use_count: s.use_count ?? 0, view_count: s.view_count ?? 0, pinned: !!s.pinned })
    }
  } catch { /* ignore */ }
  return map
}

function readSkillName(skillMd: string, fallback: string): string {
  let inFrontmatter = false
  for (const line of skillMd.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '---') {
      if (inFrontmatter) break
      inFrontmatter = true
      continue
    }
    if (inFrontmatter && trimmed.startsWith('name:')) {
      const name = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '')
      if (name) return name
    }
  }
  return fallback
}

function isIgnoredSkillPath(relPath: string): boolean {
  return relPath
    .split(/[\\/]+/)
    .some(part => part.startsWith('.') || part === 'node_modules' || part === '__pycache__')
}

function isSkillMarkdownPath(relPath: string): boolean {
  return relPath === 'SKILL.md' || relPath.endsWith('/SKILL.md') || relPath.endsWith('\\SKILL.md')
}

function categoryFromRelativeSkillDir(relDir: string): string {
  const parts = relDir.split(/[\\/]+/).filter(Boolean)
  return parts.length > 1 ? parts[0] : 'misc'
}

async function findSkillDir(skillsDir: string, category: string, skillName: string): Promise<string | null> {
  const searchRoot = category === 'misc' ? skillsDir : join(skillsDir, category)
  const files = await listFilesRecursive(searchRoot, '').catch(() => [])
  for (const file of files) {
    if (!isSkillMarkdownPath(file.path) || isIgnoredSkillPath(file.path)) continue
    const skillMdPath = join(searchRoot, file.path)
    const skillMd = await safeReadFile(skillMdPath)
    if (!skillMd) continue
    const skillDir = dirname(skillMdPath)
    const fallback = skillDir.split(/[\\/]/).pop() || skillName
    if (readSkillName(skillMd, fallback) === skillName) return skillDir
  }
  return null
}

/**
 * Scan all skills recursively.
 *
 * Supports flat skills and nested skills at any depth:
 *   - skills/<skill-name>/SKILL.md -> misc
 *   - skills/<category>/.../<skill-name>/SKILL.md -> <category>
 */
async function scanSkillsDir(skillsDir: string, bundledManifest: Map<string, string>, hubNames: Set<string>, disabledList: string[], usageStats: Map<string, UsageStats>) {
  const files = await listFilesRecursive(skillsDir, '')
  const categoryMap = new Map<string, { name: string; description: string; skills: any[] }>()

  for (const file of files) {
    if (!isSkillMarkdownPath(file.path) || isIgnoredSkillPath(file.path)) continue

    const skillMdPath = join(skillsDir, file.path)
    const skillMd = await safeReadFile(skillMdPath)
    if (!skillMd) continue

    const skillDir = dirname(skillMdPath)
    const relDir = relative(skillsDir, skillDir)
    const fallbackName = relDir.split(/[\\/]+/).filter(Boolean).pop() || relDir
    const skillName = readSkillName(skillMd, fallbackName)
    const categoryName = categoryFromRelativeSkillDir(relDir)

    let category = categoryMap.get(categoryName)
    if (!category) {
      const description = categoryName === 'misc'
        ? 'Misc'
        : (await safeReadFile(join(skillsDir, categoryName, 'DESCRIPTION.md')))
          ?.trim()
          .split('\n')[0]
          .replace(/^#+\s*/, '')
          .slice(0, 100) || ''
      category = { name: categoryName, description, skills: [] }
      categoryMap.set(categoryName, category)
    }

    const source = getSkillSource(skillName, bundledManifest, hubNames)
    let modified = false
    if (source === 'builtin') {
      const manifestHash = bundledManifest.get(skillName)
      if (manifestHash) {
        const currentHash = await dirHash(skillDir)
        modified = currentHash !== manifestHash
      }
    }
    const usage = usageStats.get(skillName)
    category.skills.push({
      name: skillName,
      description: extractDescription(skillMd),
      enabled: !disabledList.includes(skillName),
      source,
      modified: modified || undefined,
      patchCount: usage?.patch_count,
      useCount: usage?.use_count,
      viewCount: usage?.view_count,
      pinned: usage?.pinned || undefined,
    })
  }

  const categories = Array.from(categoryMap.values()).filter(cat => cat.skills.length > 0)
  categories.sort((a, b) => a.name.localeCompare(b.name))
  for (const cat of categories) { cat.skills.sort((a: any, b: any) => a.name.localeCompare(b.name)) }
  return categories
}

export async function list(ctx: any) {
  const skillsDir = join(getHermesDir(), 'skills')
  try {
    const config = await readConfigYaml()
    const disabledList: string[] = config.skills?.disabled || []

    // Read provenance sources
    const bundledManifest = readBundledManifest(await safeReadFile(join(skillsDir, '.bundled_manifest')))
    const hubNames = readHubInstalledNames(await safeReadFile(join(skillsDir, '.hub', 'lock.json')))
    const usageStats = readUsageStats(await safeReadFile(join(skillsDir, '.usage.json')))

    const categories = await scanSkillsDir(skillsDir, bundledManifest, hubNames, disabledList, usageStats)

    // Read archived skills from .archive/
    const archived: any[] = []
    const archiveDir = join(skillsDir, '.archive')
    const archiveEntries = await readdir(archiveDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[])
    for (const entry of archiveEntries) {
      if (!entry.isDirectory()) continue
      const skillMd = await safeReadFile(join(archiveDir, entry.name, 'SKILL.md'))
      if (skillMd) {
        const name = readSkillName(skillMd, entry.name)
        const usage = usageStats.get(name)
        archived.push({
          name,
          description: extractDescription(skillMd),
          source: getSkillSource(name, bundledManifest, hubNames),
          patchCount: usage?.patch_count,
          useCount: usage?.use_count,
          viewCount: usage?.view_count,
          pinned: usage?.pinned || undefined,
        })
      }
    }
    archived.sort((a: any, b: any) => a.name.localeCompare(b.name))

    ctx.body = { categories, archived }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `Failed to read skills directory: ${err.message}` }
  }
}

export async function usageStats(ctx: any) {
  const rawDays = parseInt(String(ctx.query?.days ?? '7'), 10)
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 7

  try {
    ctx.body = await getSkillUsageStatsFromDb(days)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `Failed to read skill usage stats: ${err.message}` }
  }
}

export async function toggle(ctx: any) {
  const { name, enabled } = ctx.request.body as { name?: string; enabled?: boolean }
  if (!name || typeof enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or enabled flag' }
    return
  }
  try {
    await updateConfigYaml((config) => {
      if (!config.skills) config.skills = {}
      if (!Array.isArray(config.skills.disabled)) config.skills.disabled = []
      const disabled = config.skills.disabled as string[]
      const idx = disabled.indexOf(name)
      if (enabled) { if (idx !== -1) disabled.splice(idx, 1) }
      else { if (idx === -1) disabled.push(name) }
      return config
    })
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function listFiles(ctx: any) {
  const { category, skill } = ctx.params
  const skillsDir = join(getHermesDir(), 'skills')
  try {
    const skillDir = await findSkillDir(skillsDir, category, skill)
    if (!skillDir) {
      ctx.status = 404
      ctx.body = { error: 'Skill not found' }
      return
    }
    const allFiles = await listFilesRecursive(skillDir, '')
    const files = allFiles.filter(f => f.path !== 'SKILL.md')
    ctx.body = { files }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function readFile_(ctx: any) {
  const filePath = String((ctx.params as any).path || '')
  const skillsDir = join(getHermesDir(), 'skills')
  const parts = filePath.split('/').filter(Boolean)
  let fullPath: string

  if (parts.length >= 3) {
    const [category, skill, ...rest] = parts
    const skillDir = await findSkillDir(skillsDir, category, skill)
    if (!skillDir) {
      ctx.status = 404
      ctx.body = { error: 'Skill not found' }
      return
    }
    fullPath = resolve(join(skillDir, rest.join('/')))
  } else {
    const realPath = filePath.startsWith('misc/') ? filePath.slice(5) : filePath
    fullPath = resolve(join(skillsDir, realPath))
  }

  const resolvedSkillsDir = resolve(skillsDir)
  if (fullPath !== resolvedSkillsDir && !fullPath.startsWith(resolvedSkillsDir + '\\') && !fullPath.startsWith(resolvedSkillsDir + '/')) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  const content = await safeReadFile(fullPath)
  if (content === null) {
    ctx.status = 404
    ctx.body = { error: 'File not found' }
    return
  }
  ctx.body = { content }
}

export async function pin_(ctx: any) {
  const { name, pinned } = ctx.request.body as { name?: string; pinned?: boolean }
  if (!name || typeof pinned !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or pinned flag' }
    return
  }
  try {
    await pinSkill(name, pinned)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
