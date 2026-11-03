/**
 * Static checks for the 0.3 GUI contract:
 *   - package.json declares dsh.client and exports["./client"]
 *   - client.js exists, is lexically valid, and names the exact package id
 *   - the row id in cordis.patch.yml equals the row id in the plugins.row.config key
 * Run with `node scripts/verify-gui.mjs` from the plugin root.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function read(relative) {
  const file = path.join(root, relative)
  if (!fs.existsSync(file)) {
    problems.push(`missing file: ${relative}`)
    return ''
  }
  return fs.readFileSync(file, 'utf8')
}

const pkg = JSON.parse(read('package.json') || '{}')
const name = pkg.name || ''
if (!pkg.dsh?.bundle?.patch) problems.push('package.json: dsh.bundle.patch is missing')
if (!pkg.dsh?.client) problems.push('package.json: dsh.client is missing (browser half will not load)')
else if (pkg.dsh.client.platform !== 'web') problems.push('package.json: dsh.client.platform must be "web"')
if (!pkg.exports?.['./client']) problems.push('package.json: exports["./client"] is missing')
if (!Array.isArray(pkg.files) || !pkg.files.includes('client.js')) problems.push('package.json: files must include "client.js"')

const client = read('client.js')
if (client) {
  if (!client.includes(`id: '${name}'`) && !client.includes(`id: "${name}"`)) {
    problems.push(`client.js: window.__ModuleLoader__.load id must equal the package name "${name}"`)
  }
  if (!client.includes("'plugins.row.config'")) problems.push('client.js: plugins.row.config registration is missing')
}

const patch = read('cordis.patch.yml')
const rowMatch = patch.match(/- id:\s*([A-Za-z0-9._-]+)/)
const rowId = rowMatch ? rowMatch[1] : ''
if (!rowId) problems.push('cordis.patch.yml: no plugin row id found')
else if (client && !client.includes(`${name}#${rowId}`)) {
  problems.push(`client.js: plugins.row.config key must be "${name}#${rowId}"`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error('FAIL -', problem)
  process.exit(1)
}
console.log(`OK - ${name} row "${rowId}" has a loadable browser half`)
