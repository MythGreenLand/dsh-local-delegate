/**
 * Unit checks for lib/levels.js (pure level/workspace policy logic).
 * Run with `node scripts/test-levels.mjs`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LEVELS,
  LEVEL_GUIDANCE_ORDER,
  LOCAL_TOOLS,
  EXECUTION_TOOLS,
  READONLY_TOOLS,
  TEAM_TOOLS,
  PLANNING_TOOLS,
  normalizeLevel,
  canonicalPath,
  samePath,
  findLevelKey,
  resolveLevel,
  sessionWorkspace,
  levelOfAgent,
  isChildAgent,
  teamRole,
  policyKind,
  plannerDenyList,
  levelPromptText,
} from '../lib/levels.js'

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

function agentFor({ sessionId = 's1', cwd = 'C:\\Work\\Alpha', parentSession = null } = {}) {
  return { session: { id: sessionId, header: { cwd, parentSession } } }
}

function mockRegistry(entities) {
  return { list: () => entities }
}

const WORKSPACES = [
  { id: 'ws-a', title: 'Alpha', path: 'C:\\Work\\Alpha', sessionIds: ['s1'] },
  { id: 'ws-b', title: 'Beta', path: 'C:\\Work\\Beta', sessionIds: [] },
]

check('constants match the contract', () => {
  assert.deepEqual(LEVELS, ['none', 'light', 'default', 'high', 'max'])
  assert.deepEqual(LOCAL_TOOLS, ['local_transform', 'local_batch', 'local_health'])
  assert.deepEqual(EXECUTION_TOOLS, ['bash', 'pwsh', 'write', 'edit', 'terminal', 'workflow', 'ralph', 'subagent', 'local_transform', 'local_batch'])
  assert.deepEqual(READONLY_TOOLS, ['read', 'glob', 'grep'])
  assert.deepEqual(TEAM_TOOLS, [
    'spawn_teammate',
    'send_message',
    'list_agents',
    'wait_agent',
    'interrupt_agent',
    'team_task_create',
    'team_task_list',
    'team_task_get',
    'team_task_update',
  ])
  assert.ok(PLANNING_TOOLS.includes('todo_write'))
  assert.ok(PLANNING_TOOLS.includes('ask_user_question'))
  assert.equal(LEVEL_GUIDANCE_ORDER, 10050)
})

check('normalizeLevel accepts exactly the five levels', () => {
  for (const level of LEVELS) assert.equal(normalizeLevel(level), level)
  assert.equal(normalizeLevel('MAX'), null)
  assert.equal(normalizeLevel(' default '), null)
  assert.equal(normalizeLevel(''), null)
  assert.equal(normalizeLevel(undefined), null)
  assert.equal(normalizeLevel(2), null)
})

check('canonicalPath uses realpath when possible and resolves otherwise', () => {
  assert.equal(canonicalPath(''), '')
  assert.equal(canonicalPath(undefined), '')
  assert.equal(canonicalPath(process.cwd()), fs.realpathSync.native(process.cwd()))
  const missing = path.join(os.tmpdir(), `dsh-levels-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  assert.equal(canonicalPath(missing), path.resolve(missing))
})

check('samePath ignores case, separator style, and trailing separators', () => {
  assert.equal(samePath('C:\\Work\\Alpha', 'c:/work/alpha'), true)
  assert.equal(samePath('C:\\Work\\Alpha\\', 'C:/Work/Alpha/'), true)
  assert.equal(samePath('C:\\Work\\Alpha', 'C:\\Work\\Beta'), false)
  assert.equal(samePath('C:\\Work\\Alpha', '/work/alpha'), false)
  assert.equal(samePath('', ''), false)
  assert.equal(samePath(null, 'C:\\Work\\Alpha'), false)
  assert.equal(samePath('C:\\Work\\Alpha', undefined), false)
})

check('findLevelKey matches case/separator-insensitively and returns the original key', () => {
  const levels = { 'C:\\Work\\Alpha': 'high', 'D:/Other': 'none' }
  assert.equal(findLevelKey(levels, 'c:/work/alpha'), 'C:\\Work\\Alpha')
  assert.equal(findLevelKey(levels, 'C:\\WORK\\ALPHA\\'), 'C:\\Work\\Alpha')
  assert.equal(findLevelKey(levels, 'C:\\Work\\Beta'), null)
  assert.equal(findLevelKey(undefined, 'C:\\Work\\Alpha'), null)
  assert.equal(findLevelKey({}, 'C:\\Work\\Alpha'), null)
  assert.equal(findLevelKey(levels, ''), null)
})

check('resolveLevel: workspace override, default fallback, disabled levels, invalid values', () => {
  const config = {
    levelsEnabled: true,
    defaultLevel: 'light',
    workspaceLevels: { 'c:/work/alpha': 'high', 'C:\\Work\\Beta': 'none' },
  }
  assert.equal(resolveLevel(config, 'C:\\Work\\Alpha'), 'high')
  assert.equal(resolveLevel(config, 'C:\\WORK\\ALPHA\\'), 'high')
  assert.equal(resolveLevel(config, 'C:\\Work\\Beta'), 'none')
  assert.equal(resolveLevel(config, 'C:\\Work\\Unknown'), 'light')
  assert.equal(resolveLevel(config, ''), 'light')
  assert.equal(resolveLevel({ ...config, levelsEnabled: false }, 'C:\\Work\\Alpha'), 'default')
  assert.equal(resolveLevel({ ...config, defaultLevel: 'bogus' }, 'C:\\Work\\Unknown'), 'default')
  assert.equal(resolveLevel({ levelsEnabled: true, defaultLevel: 'max', workspaceLevels: { 'C:\\Work\\Alpha': 'bogus' } }, 'C:\\Work\\Alpha'), 'max')
  assert.equal(resolveLevel(undefined, 'C:\\Work\\Alpha'), 'default')
})

check('sessionWorkspace prefers sessionIds and falls back to canonical cwd', () => {
  const registry = mockRegistry(WORKSPACES)
  // Session id match wins even when cwd points at another workspace.
  const bySession = sessionWorkspace(registry, agentFor({ sessionId: 's1', cwd: 'C:\\Work\\Beta' }))
  assert.equal(bySession?.id, 'ws-a')
  // No session membership: canonical cwd matching (case/separator-insensitive).
  const byCwd = sessionWorkspace(registry, agentFor({ sessionId: 's9', cwd: 'c:/work/alpha/' }))
  assert.equal(byCwd?.id, 'ws-a')
  const unmatched = sessionWorkspace(registry, agentFor({ sessionId: 's9', cwd: 'C:\\Elsewhere' }))
  assert.equal(unmatched, null)
  assert.equal(sessionWorkspace(undefined, agentFor()), null)
  assert.equal(sessionWorkspace(mockRegistry([]), agentFor()), null)
  assert.equal(sessionWorkspace({ list: () => { throw new Error('boom') } }, agentFor()), null)
  assert.equal(sessionWorkspace(registry, { session: { id: 's1' } })?.id, 'ws-a')
  assert.equal(sessionWorkspace(registry, undefined), null)
})

check('levelOfAgent reports workspace/default/unmatched sources', () => {
  const config = {
    levelsEnabled: true,
    defaultLevel: 'light',
    workspaceLevels: { 'c:/work/alpha': 'max' },
  }
  const registry = mockRegistry(WORKSPACES)
  const overridden = levelOfAgent({ config, workspaceRegistry: registry, agent: agentFor({ sessionId: 's1', cwd: 'C:\\Work\\Beta' }) })
  assert.deepEqual(overridden, { level: 'max', workspace: WORKSPACES[0], source: 'workspace' })
  const defaulted = levelOfAgent({ config, workspaceRegistry: registry, agent: agentFor({ sessionId: 's9', cwd: 'C:\\Work\\Beta' }) })
  assert.deepEqual(defaulted, { level: 'light', workspace: WORKSPACES[1], source: 'default' })
  const unmatched = levelOfAgent({ config, workspaceRegistry: registry, agent: agentFor({ sessionId: 's9', cwd: 'C:\\Elsewhere' }) })
  assert.equal(unmatched.level, 'light')
  assert.equal(unmatched.workspace, null)
  assert.equal(unmatched.source, 'unmatched')
  const disabled = levelOfAgent({ config: { ...config, levelsEnabled: false }, workspaceRegistry: registry, agent: agentFor() })
  assert.equal(disabled.level, 'default')
  assert.equal(disabled.source, 'default')
  assert.equal(levelOfAgent({ config, workspaceRegistry: mockRegistry(WORKSPACES) }).source, 'unmatched')
})

check('isChildAgent / teamRole / policyKind classify root, child, and team roles', () => {
  assert.equal(isChildAgent(agentFor()), false)
  assert.equal(isChildAgent(agentFor({ parentSession: null })), false)
  assert.equal(isChildAgent(agentFor({ parentSession: 'parent-session' })), true)
  assert.equal(isChildAgent(undefined), false)

  const leadCtx = { get: (name) => (name === 'agentTeams' ? { tryMembership: () => ({ role: 'lead' }) } : undefined) }
  const teammateCtx = { get: (name) => (name === 'agentTeams' ? { tryMembership: () => ({ role: 'teammate' }) } : undefined) }
  const brokenCtx = { get: (name) => (name === 'agentTeams' ? { tryMembership: () => { throw new Error('boom') } } : undefined) }
  const throwingGetCtx = { get: () => { throw new Error('boom') } }
  assert.equal(teamRole(leadCtx, agentFor()), 'lead')
  assert.equal(teamRole(teammateCtx, agentFor()), 'teammate')
  assert.equal(teamRole(brokenCtx, agentFor()), undefined)
  assert.equal(teamRole(throwingGetCtx, agentFor()), undefined)
  assert.equal(teamRole({ get: () => undefined }, agentFor()), undefined)
  assert.equal(teamRole(undefined, agentFor()), undefined)

  assert.equal(policyKind(leadCtx, agentFor()), 'planner')
  assert.equal(policyKind({}, agentFor()), 'planner')
  assert.equal(policyKind(teammateCtx, agentFor()), 'worker')
  assert.equal(policyKind({}, agentFor({ parentSession: 'p' })), 'worker')
  assert.equal(policyKind(teammateCtx, agentFor({ parentSession: 'p' })), 'worker')
})

const BASE_TOOLS = [
  'bash',
  'pwsh',
  'write',
  'edit',
  'read',
  'glob',
  'grep',
  'workflow',
  'ralph',
  'subagent',
  'local_transform',
  'local_batch',
  'local_health',
  'todo_write',
  'present',
  'run_code',
  'my_custom_tool',
  'spawn_teammate',
  'send_message',
  'skill',
]

check('plannerDenyList default: executes denied, read-only kept, team keeps subagent, run_code absent', () => {
  const deny = plannerDenyList({ knownTools: BASE_TOOLS, config: { plannerAllowRead: true } })
  assert.deepEqual(deny, ['bash', 'pwsh', 'write', 'edit', 'workflow', 'ralph', 'local_transform', 'local_batch']);
  assert.ok(!deny.includes('local_health'), 'local_health is a kept diagnostic at L4')
  assert.ok(!deny.includes('read'))
  assert.ok(!deny.includes('glob'))
  assert.ok(!deny.includes('grep'))
  assert.ok(!deny.includes('subagent'), 'team tools present keeps subagent')
  assert.ok(!deny.includes('run_code'))
  assert.ok(!deny.includes('my_custom_tool'))
  assert.ok(!deny.includes('todo_write'))
  assert.ok(!deny.includes('skill'))
})

check('plannerDenyList honors plannerAllowRead=false and plannerAllowExtra', () => {
  const deny = plannerDenyList({ knownTools: BASE_TOOLS, config: { plannerAllowRead: false } })
  assert.deepEqual(deny, ['bash', 'pwsh', 'write', 'edit', 'read', 'glob', 'grep', 'workflow', 'ralph', 'local_transform', 'local_batch']);
  assert.ok(!deny.includes('local_health'), 'local_health is a kept diagnostic at L4')
  const allowed = plannerDenyList({
    knownTools: BASE_TOOLS,
    config: { plannerAllowRead: true, plannerAllowExtra: ['bash', 'write', 'my_custom_tool'] },
  })
  assert.ok(!allowed.includes('bash'))
  assert.ok(!allowed.includes('write'))
  assert.ok(allowed.includes('pwsh'))
})

check('plannerDenyList honors plannerDenyExtra but never names run_code', () => {
  const deny = plannerDenyList({
    knownTools: BASE_TOOLS,
    config: { plannerAllowRead: true, plannerDenyExtra: ['my_custom_tool', 'run_code', 'bash'] },
  })
  assert.ok(deny.includes('my_custom_tool'))
  assert.ok(deny.includes('bash'))
  assert.ok(!deny.includes('run_code'))
  assert.deepEqual(new Set(deny).size, deny.length)
})

check('plannerDenyList denies subagent when no team tools are present', () => {
  const known = BASE_TOOLS.filter((name) => !TEAM_TOOLS.includes(name))
  const deny = plannerDenyList({ knownTools: known, config: {} })
  assert.ok(deny.includes('subagent'))
  assert.ok(!deny.includes('todo_write'))
})

check('plannerDenyList dedupes and is stable; unknown tools default-allow', () => {
  const known = ['bash', 'bash', 'mystery_tool', 'read', 'write']
  assert.deepEqual(plannerDenyList({ knownTools: known, config: {} }), ['bash', 'write'])
  assert.deepEqual(plannerDenyList({ knownTools: undefined, config: {} }), [])
  assert.deepEqual(plannerDenyList({ knownTools: ['unknown'], config: { plannerDenyExtra: ['unknown'] } }), ['unknown'])
})

check('levelPromptText covers all levels and role variants', () => {
  const config = { lightMinChars: 1234, lightMinFiles: 5, highMinChars: 2500, plannerAllowRead: false }
  assert.equal(levelPromptText('default', { config }), '')
  assert.equal(levelPromptText('bogus', { config }), '')

  const none = levelPromptText('none', { config })
  assert.match(none, /disabled/i)
  assert.match(none, /local_\*/)

  const light = levelPromptText('light', { config })
  assert.match(light, /light/)
  assert.match(light, /1234/)
  assert.match(light, /5 files/)

  const high = levelPromptText('high', { config })
  assert.match(high, /high/)
  assert.match(high, /2500/)
  assert.match(high, /local_worker/)

  const max = levelPromptText('max', { config, teamRole: 'lead', slaveTeam: { enabled: true } })
  assert.match(max, /planner/i)
  assert.match(max, /local_worker/)
  assert.match(max, /todo_write/)
  assert.match(max, /read\/glob\/grep are disabled/)
  assert.match(max, /Agent Teams/)
  assert.match(max, /slave_team_spawn/)

  const maxRead = levelPromptText('max', { config: { plannerAllowRead: true } })
  assert.match(maxRead, /read\/glob\/grep remain available/)

  const worker = levelPromptText('max', { config, role: 'worker' })
  assert.match(worker, /worker agent/i)
  assert.match(worker, /verifiable/)
  assert.doesNotMatch(worker, /You are the planner/)
  assert.doesNotMatch(levelPromptText('none', { config, role: 'worker' }), /planner/i)
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log('ok   -', name)
  } catch (error) {
    failed += 1
    console.error('FAIL -', name)
    console.error(error)
  }
}
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log(`\nall ${checks.length} checks passed`)
