/**
 * `local_worker` — hand one self-contained task to a local-model worker subagent.
 *
 * The tool is registered only in the scoped context of L3/L4 planner agents
 * (see lib/policy.js), never globally and never for child/teammate agents.
 * It starts a continuable subagent through lib/slaves.js's `startSlaveActivation`
 * (dependency-injected so this module stays testable without the DSH runtime)
 * and returns immediately with the child id; the worker's result arrives as a
 * parent notification.
 *
 * Failure policy: `plannerFallback === 'strong-worker'` becomes `fallback:
 * 'inherit'`, so startSlaveActivation retries the worker on the parent model
 * when the local route cannot be used; `'fail'` surfaces an actionable error.
 */
import * as statsModule from './stats.js'
import { preflightSlaveRoute } from './slaves.js'

const MIN_DEPTH = 1
const MAX_DEPTH = 5

function configNow(getConfig) {
  try {
    const value = typeof getConfig === 'function' ? getConfig() : undefined
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function clampDepth(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, Math.floor(number)))
}

function recordWorkerStart(stats, node) {
  try {
    statsModule.recordWorkerStart?.(stats, node)
  } catch {
    /* statistics must never break the tool */
  }
}

function recordWorkerFailure(stats, message) {
  try {
    statsModule.recordWorkerFailure?.(stats, message)
  } catch {
    /* statistics must never break the tool */
  }
}

/** Attach the remediation the user/agent actually needs to every start failure. */
function workerFailure(error, config) {
  if (error?.code === 'LOCAL_MODEL_UNSET' || error?.code === 'LOCAL_WORKER_PROVIDER_MISSING') return error
  const message = String(error?.message ?? error)
  const route = `${config.workerRouteProvider || 'local-delegate'}/${config.workerRouteModel || config.endpoint?.model || '(model unset)'}`
  const wrapped = new Error(
    `LOCAL_WORKER_FAILED: ${message}. ` +
      `The worker route is ${route}. ` +
      'Fix by enabling the local endpoint as a Subagent model on the local model page (that registers the `local-delegate` LLM route), ' +
      'checking workerRouteProvider/workerRouteModel, or setting plannerFallback to "strong-worker" so the worker inherits the parent model.',
  )
  wrapped.code = error?.code || 'LOCAL_WORKER_FAILED'
  return wrapped
}

function receiptText(value) {
  if (!value || typeof value !== 'object') return String(value)
  const lines = []
  lines.push(`local_worker started: ${value.task || 'worker task'}`)
  if (value.subagentId) lines.push(`child: ${value.subagentId}`)
  lines.push(`route: ${value.routed_to || 'local model'} (subagent provider ${value.provider}, preset ${value.preset}, max depth ${value.max_depth})`)
  if (value.fallback === 'inherit') lines.push('fallback: the worker inherits the parent model instead of the local route')
  lines.push('The worker runs asynchronously; its result is delivered as a notification when it settles. Review it (diff/tests) before relying on it.')
  return lines.join('\n')
}

/**
 * Create the `local_worker` tool definition.
 * @param {object} deps
 * @param {object} deps.ctx Host plugin context (service lookup only).
 * @param {() => object} deps.getConfig live normalized config reader.
 * @param {(spec: object) => Promise<object>|object} deps.startSlaveActivation
 *   lib/slaves.js activation helper (contract §6.5); injected for tests.
 * @param {(level: string, message: string) => void} [deps.log] logger.
 * @param {object} [deps.stats] delegation statistics.
 * @returns {object} a tool definition accepted by tools.register().
 */
export function createLocalWorkerTool({ ctx, getConfig, startSlaveActivation, log, stats }) {
  const lookup = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  return {
    name: 'local_worker',
    description:
      'Start one local-model worker subagent for a self-contained task: implementation, file edits, or bulk mechanical work. ' +
      'Returns the child id immediately; the worker result is delivered as a notification. ' +
      'Review the result (diff or test output) before relying on it, and verify the route "local-delegate/model" is enabled when the start fails.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short label for the worker, used in the parent notification and the slave roster.',
        },
        task: {
          type: 'string',
          description:
            'Complete, self-contained instructions: the worker sees only this text plus its preset, so include file paths, the expected result, and how to verify it.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory override for the worker; defaults to the parent session working directory.',
        },
        max_depth: {
          type: 'number',
          description: 'Delegation depth for the worker (1-5). Defaults to workerMaxDepth; 1 means the worker cannot start further workers.',
        },
      },
      required: ['description', 'task'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: receiptText(value) }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const config = configNow(getConfig)
      const input = args && typeof args === 'object' ? args : {}
      const parent = exec?.agent
      if (!parent) {
        throw new Error(
          'LOCAL_WORKER_NO_AGENT: local_worker must run inside an agent turn (no exec.agent); ' +
            'call it from the planner agent, or do the work yourself.',
        )
      }
      const description = typeof input.description === 'string' ? input.description.trim() : ''
      const task = typeof input.task === 'string' ? input.task.trim() : ''
      if (!description) throw new Error('LOCAL_WORKER_DESCRIPTION_REQUIRED: pass a short "description" for the worker label')
      if (!task) throw new Error('LOCAL_WORKER_TASK_REQUIRED: pass the complete task instructions in "task"')

      const model = String(config.workerRouteModel || config.endpoint?.model || '').trim()
      if (!model) {
        const error = new Error(
          'LOCAL_MODEL_UNSET: local_worker needs a model. Set endpoint.model (for example "gemma4:e2b") or workerRouteModel ' +
            'in the local-delegate config, then enable the local endpoint as a Subagent model in the local model page.',
        )
        error.code = 'LOCAL_MODEL_UNSET'
        throw error
      }

      const subagents = lookup('subagents')
      if (subagents && typeof subagents.getProvider === 'function' && typeof config.workerProvider === 'string' && config.workerProvider) {
        const provider = subagents.getProvider(config.workerProvider)
        if (!provider) {
          const error = new Error(
            `LOCAL_WORKER_PROVIDER_MISSING: subagent provider "${config.workerProvider}" is not registered in this profile; ` +
              'set workerProvider to an installed provider (for example "spawn"), then retry.',
          )
          error.code = 'LOCAL_WORKER_PROVIDER_MISSING'
          throw error
        }
      }

      if (typeof startSlaveActivation !== 'function') {
        const error = new Error(
          'LOCAL_WORKER_UNAVAILABLE: the local-delegate activation helper is missing; reinstall the plugin (lib/slaves.js must export startSlaveActivation).',
        )
        error.code = 'LOCAL_WORKER_UNAVAILABLE'
        throw error
      }

      const node = {
        name: 'local-worker',
        kind: 'local',
        provider: String(config.workerRouteProvider || 'local-delegate'),
        model,
      }
      const fallback = config.plannerFallback === 'strong-worker' ? 'inherit' : 'fail'
      const maxDepth = clampDepth(input.max_depth, clampDepth(config.workerMaxDepth, 1))

      let activation
      try {
        // Validate the worker route before a child is created; otherwise a bad
        // route would surface only at the child's first model call.
        await preflightSlaveRoute(ctx, node, exec?.signal)
        activation = await startSlaveActivation({
          ctx,
          parent,
          task,
          label: description,
          node,
          preset: config.workerPreset,
          maxDepth,
          provider: config.workerProvider,
          fallback,
          signal: exec?.signal,
          ...(typeof input.cwd === 'string' && input.cwd.trim() ? { cwd: input.cwd.trim() } : {}),
        })
      } catch (error) {
        recordWorkerFailure(stats, String(error?.message ?? error))
        try {
          log?.('warn', `local_worker start failed: ${String(error?.message ?? error).slice(0, 240)}`)
        } catch {
          /* logging must never mask the failure */
        }
        throw workerFailure(error, config)
      }

      const subagentId = activation?.childId ?? activation?.subagentId ?? activation?.subagent_id ?? ''
      if (!subagentId) {
        const message = 'LOCAL_WORKER_NO_CHILD: the activation helper did not return a child id; check the subagent provider.'
        recordWorkerFailure(stats, message)
        const error = new Error(message)
        error.code = 'LOCAL_WORKER_NO_CHILD'
        throw error
      }
      const usedFallback = activation?.fallback === 'inherit' ? 'inherit' : 'none'
      recordWorkerStart(stats, { ...node, fallback: usedFallback })

      return {
        kind: 'activation',
        subagentId,
        node: activation?.node ?? node,
        fallback: usedFallback,
        provider: config.workerProvider,
        preset: config.workerPreset,
        max_depth: maxDepth,
        task: description,
        routed_to: `${node.provider}/${node.model}`,
      }
    },
  }
}
