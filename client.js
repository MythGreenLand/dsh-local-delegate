/**
 * dsh-local-delegate — browser half.
 *
 * Two surfaces share one controller:
 *   1. `plugins.row.config` — the Configure button on the dsh-local-delegate row
 *      under Plugins → Installed plugins;
 *   2. `settings.section` — a "本地模型" section in the Settings navigation.
 *
 * The page reads and writes the Host row config `local-delegate` through
 * `ctx.configForms` (volatile fields only), asks the plugin's own same-origin
 * HTTP API for endpoint probes and savings statistics, and can register the
 * current endpoint as an `llm-pi-ai` route plus a Subagent allowed model.
 *
 * Hand-written ModuleLoader bundle: no build step, no JSX, React only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-delegate',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const {
      createElement: h,
      Fragment,
      useState,
      useEffect,
      useCallback,
      useMemo,
      useRef,
      useSyncExternalStore,
    } = React

    const NS = 'settings.localDelegate'
    const CONFIG_NS = 'local-delegate'
    const PI_NS = 'llm-pi-ai'
    const SUBAGENT_NS = 'subagent-model-selection-settings'
    const ROUTE_PROVIDER = 'local-delegate'

    const TASK_LABELS = {
      translate: 'translate',
      summarize: 'summarize',
      extract: 'extract',
      classify: 'classify',
      rewrite: 'rewrite',
      commit_message: 'commit message',
      names: 'names',
    }

    const EN = {
      nav: 'Local model',
      title: 'Local / degraded model',
      subtitle:
        'Endpoint used by dsh-local-delegate for mechanical text work (translation, summaries, extraction, classification, rewrites). Changes save to the active profile and apply within seconds.',
      summary: 'Local cheap-model endpoint used for mechanical text work.',
      loading: 'Loading configuration…',
      unavailable:
        'The local-delegate row is not loaded, so its settings are unavailable. Enable it under Plugins → Installed plugins.',
      readonly: 'This deployment stores settings read-only.',
      refresh: 'Refresh status',
      refreshHint: 'Re-probe the saved endpoint and reload the status card.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard changes',
      resetAll: 'Restore inherited defaults',
      saved: 'Saved. The plugin applies the new endpoint within a few seconds.',
      saveFailed: 'The Host refused these values (or the configuration changed elsewhere). The draft was kept.',
      conflict: 'Another editor changed this row. Refresh and try again.',
      dirty: 'Unsaved changes',
      noChanges: 'No changes to save.',
      test: 'Test connection',
      testing: 'Testing…',
      testHint: 'Probes the values currently in the form without saving them.',
      models: 'Fetch models',
      modelsEmpty: 'The endpoint did not advertise any model.',
      model: 'Model',
      modelHint: 'Exact model id the endpoint serves (for example gemma4:e2b).',
      kind: 'Protocol',
      kindOllama: 'Ollama native (/api/chat)',
      kindOpenAI: 'OpenAI-compatible (/v1/chat/completions)',
      baseURL: 'Server address',
      baseURLHint: 'For Ollama use http://host:11434 (no /v1 suffix). For an OpenAI-compatible gateway use the base URL the gateway documents.',
      path: 'Chat path override',
      pathHint: 'Leave empty to use /api/chat or /v1/chat/completions automatically.',
      apiKey: 'API key',
      apiKeyHint: 'Optional. Only for gateways that require a key; local Ollama usually does not. Stored in the profile patch as plain text.',
      apiKeyEnv: 'API key environment variable',
      apiKeyEnvHint: 'Optional alternative to the key field: the name of an environment variable or DSH credential reference.',
      headers: 'Extra headers (JSON)',
      headersHint: 'Optional JSON object; do not put secrets here — use the key fields instead.',
      think: 'Thinking',
      thinkHint: 'Ollama native only. Leave off for thinking models so the output budget is not spent on reasoning.',
      reasoningEffort: 'Reasoning effort',
      reasoningEffortHint: 'Sent as reasoning_effort on OpenAI-compatible endpoints. "none" disables thinking.',
      numCtx: 'Context window (num_ctx)',
      keepAlive: 'Keep-alive',
      keepAliveHint: 'Ollama keep_alive value, e.g. 30m. Keeps the model loaded between calls.',
      timeoutMs: 'Request timeout (ms)',
      temperature: 'Temperature',
      maxOutputTokens: 'Max output tokens',
      advanced: 'Advanced endpoint settings',
      fallback: 'Fallback endpoints',
      fallbackHint: 'Tried in order when the primary endpoint is unreachable or returns a retryable error.',
      addFallback: 'Add fallback',
      remove: 'Remove',
      limits: 'Delegation limits',
      retries: 'Retries per endpoint',
      chunkChars: 'Chunk size (chars)',
      maxConcurrency: 'Chunk concurrency',
      maxInlineChars: 'Inline text limit (chars)',
      maxBatchFiles: 'Batch file limit',
      maxBatchChars: 'Batch character limit',
      maxSourceChars: 'Single-file limit (chars)',
      maxResultChars: 'Inline result limit (chars)',
      maxCallsPerMinute: 'Calls per minute',
      promptHelp: 'Inject delegation guidance into the system prompt',
      warmupOnStart: 'Probe the endpoint on startup and every 120s',
      probeAllowPublic: 'Allow the GUI to probe public addresses',
      probeAllowPublicHint: 'Off by default: connection tests only reach loopback/LAN targets.',
      policy: 'Path and secret policy (YAML only)',
      policyHint: 'allowOutsideCwd / allowRoots / denyGlobs stay in cordis.patch.yml on purpose. Effective values:',
      health: 'Status',
      healthAvailable: 'available',
      healthDegraded: 'degraded (using a fallback)',
      healthUnavailable: 'unavailable',
      healthUnknown: 'not probed yet',
      healthChecked: 'last probe',
      healthPrimary: 'primary',
      healthEffective: 'effective',
      healthLatency: 'latency',
      statusFailed: 'Status request failed: {error}',
      probeOk: 'Endpoint reachable in {ms}ms.',
      probeModelFound: 'Model “{model}” is advertised.',
      probeModelMissing: 'Endpoint reachable, but model “{model}” was not advertised.',
      probeFailed: 'Probe failed: {error}',
      stats: 'Savings',
      statsHint: 'In-memory counters since the plugin loaded. They reset when the plugin reloads.',
      statsCalls: 'delegated calls',
      statsFailed: 'failed',
      statsRequests: 'local requests',
      statsChars: 'chars processed',
      statsLocalTokens: 'local tokens',
      statsSaved: 'estimated main-model tokens avoided',
      statsEmpty: 'No delegated work yet. Run a translation or summary through local_transform.',
      statsSince: 'since',
      statsLastError: 'last error',
      subagent: 'Use as a Subagent / model-picker route',
      subagentHint:
        'Registers this endpoint in the DSH model catalog as provider “local-delegate” (via llm-pi-ai) and allows that route for Subagent model selection. The Subagent policy is sampled when a new session is composed, so open a new session to use it.',
      subagentEnable: 'Enable for Subagent',
      subagentDisable: 'Remove route',
      subagentEnabled: 'Registered as provider “local-delegate” and allowed for Subagent.',
      subagentNotEnabled: 'Not registered in the model catalog yet.',
      subagentUnavailable: 'The llm-pi-ai or Subagent settings namespace is not served in this deployment.',
      subagentNeedsSave: 'Save the endpoint first, then enable it for Subagent.',
      subagentNeedsModel: 'Set a model before registering the route.',
      subagentDone: 'Route registered and allowed for Subagent.',
      subagentRemoved: 'Route removed from the model catalog and Subagent policy.',
      subagentFailed: 'The Host refused the route update; check the Models / Subagent pages for diagnostics.',
      pid: 'Provider ID',
      configure: 'Configure',
      endpointSection: 'Endpoint',
    }

    const ZH = {
      nav: '本地模型',
      title: '本地 / 降智模型',
      subtitle:
        'dsh-local-delegate 执行机械文本工作（翻译、摘要、抽取、分类、改写）所用的端点。保存后写入当前 profile 并在数秒内热生效。',
      summary: '用于机械文本工作的本地廉价模型端点。',
      loading: '正在读取配置…',
      unavailable: 'local-delegate 行当前未加载，配置不可用。请到「插件 → 已安装插件」启用它。',
      readonly: '本部署的设置为只读。',
      refresh: '刷新状态',
      refreshHint: '重新探测已保存端点并刷新状态卡。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      resetAll: '恢复继承默认值',
      saved: '已保存，插件将在数秒内应用新端点。',
      saveFailed: 'Host 拒绝了这些值（或配置已被其他编辑器改动），草稿已保留。',
      conflict: '该行配置已被其他编辑器改动，请刷新后重试。',
      dirty: '有未保存的修改',
      noChanges: '没有需要保存的修改。',
      test: '测试连接',
      testing: '测试中…',
      testHint: '使用表单里当前的值探测，不保存。',
      models: '拉取模型列表',
      modelsEmpty: '端点没有返回任何模型。',
      model: '模型',
      modelHint: '端点实际提供的模型 id，例如 gemma4:e2b。',
      kind: '协议',
      kindOllama: 'Ollama 原生（/api/chat）',
      kindOpenAI: 'OpenAI 兼容（/v1/chat/completions）',
      baseURL: '服务器地址',
      baseURLHint: 'Ollama 填 http://host:11434（不要带 /v1）；OpenAI 兼容网关按其文档填写 base URL。',
      path: '对话路径覆盖',
      pathHint: '留空则自动使用 /api/chat 或 /v1/chat/completions。',
      apiKey: 'API Key',
      apiKeyHint: '可选，仅用于需要鉴权的网关；本地 Ollama 通常不需要。将以明文写入 profile patch。',
      apiKeyEnv: 'API Key 环境变量',
      apiKeyEnvHint: '可选：填写环境变量名或 DSH 凭据引用名，代替上面的密钥字段。',
      headers: '额外请求头（JSON）',
      headersHint: '可选 JSON 对象；不要把密钥写在这里，改用上面的字段。',
      think: '思考',
      thinkHint: '仅 Ollama 原生。思考模型请关闭，否则输出预算会被推理占光。',
      reasoningEffort: '推理档位',
      reasoningEffortHint: 'OpenAI 兼容端点会下发 reasoning_effort；none 表示关闭思考。',
      numCtx: '上下文窗口（num_ctx）',
      keepAlive: '保活时间',
      keepAliveHint: 'Ollama keep_alive，例如 30m，避免反复冷加载。',
      timeoutMs: '请求超时（ms）',
      temperature: '温度',
      maxOutputTokens: '最大输出 token',
      advanced: '端点高级设置',
      fallback: '备用端点',
      fallbackHint: '主端点不可达或返回可重试错误时按顺序尝试。',
      addFallback: '添加备用端点',
      remove: '删除',
      limits: '委派限制',
      retries: '每个端点的重试次数',
      chunkChars: '分块大小（字符）',
      maxConcurrency: '分块并发',
      maxInlineChars: '内联文本上限（字符）',
      maxBatchFiles: '批量文件上限',
      maxBatchChars: '批量字符上限',
      maxSourceChars: '单文件上限（字符）',
      maxResultChars: '内联结果上限（字符）',
      maxCallsPerMinute: '每分钟调用上限',
      promptHelp: '向系统提示词注入委派指引',
      warmupOnStart: '启动时及每 120 秒探活一次',
      probeAllowPublic: '允许 GUI 探测公网地址',
      probeAllowPublicHint: '默认关闭：连接测试只允许回环/内网目标。',
      policy: '路径与密钥策略（仅 YAML）',
      policyHint: 'allowOutsideCwd / allowRoots / denyGlobs 有意保留在 cordis.patch.yml。当前生效值：',
      health: '状态',
      healthAvailable: '可用',
      healthDegraded: '降级（正在使用备用端点）',
      healthUnavailable: '不可用',
      healthUnknown: '尚未探测',
      healthChecked: '最近探测',
      healthPrimary: '主端点',
      healthEffective: '生效端点',
      healthLatency: '延迟',
      statusFailed: '状态请求失败：{error}',
      probeOk: '端点可达，耗时 {ms}ms。',
      probeModelFound: '端点已声明模型“{model}”。',
      probeModelMissing: '端点可达，但未找到模型“{model}”。',
      probeFailed: '探测失败：{error}',
      stats: '节省统计',
      statsHint: '插件加载以来的内存计数，插件重载后清零。',
      statsCalls: '委派调用',
      statsFailed: '失败',
      statsRequests: '本地请求',
      statsChars: '处理字符',
      statsLocalTokens: '本地 token',
      statsSaved: '估算节省的主模型 token',
      statsEmpty: '还没有委派记录。用 local_transform 跑一次翻译或摘要即可看到统计。',
      statsSince: '统计起点',
      statsLastError: '最近错误',
      subagent: '作为 Subagent / 模型选择器路由',
      subagentHint:
        '把当前端点注册进 DSH 模型目录（通过 llm-pi-ai，provider 名为 local-delegate），并加入 Subagent 的可选模型。Subagent 策略在新建会话时采样，启用后请新开会话使用。',
      subagentEnable: '启用为 Subagent 模型',
      subagentDisable: '移除路由',
      subagentEnabled: '已注册为 provider “local-delegate”，并已加入 Subagent 可选模型。',
      subagentNotEnabled: '尚未注册到模型目录。',
      subagentUnavailable: '本部署未提供 llm-pi-ai 或 Subagent 设置命名空间。',
      subagentNeedsSave: '先保存端点，再启用为 Subagent 模型。',
      subagentNeedsModel: '请先填写模型再注册路由。',
      subagentDone: '路由已注册，并已加入 Subagent 可选模型。',
      subagentRemoved: '已从模型目录与 Subagent 策略中移除该路由。',
      subagentFailed: 'Host 拒绝了路由更新，请到 Models / Subagent 页面查看诊断。',
      pid: 'Provider ID',
      configure: '配置',
      endpointSection: '端点',
    }

    const DICT = { en: EN, zh: ZH }

    const CSS = `
.ld_root{display:flex;flex-direction:column;gap:16px;max-width:980px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}
.ld_head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.ld_head h2{margin:0;font-size:16px;font-weight:600}
.ld_sub{color:var(--dsw-alias-label-secondary);margin:4px 0 0;max-width:760px}
.ld_badge{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ld_badge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.ld_badge.warn{color:var(--dsw-alias-state-warning-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 45%,transparent)}
.ld_badge.err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.ld_card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px}
.ld_card h3{margin:0;font-size:13.5px;font-weight:600}
.ld_row{display:flex;flex-wrap:wrap;gap:12px}
.ld_field{display:flex;flex-direction:column;gap:5px;flex:1 1 240px;min-width:220px}
.ld_field label{font-weight:500;color:var(--dsw-alias-label-primary)}
.ld_field .hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ld_field input,.ld_field select,.ld_field textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;outline:none}
.ld_field input:focus,.ld_field select:focus,.ld_field textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.ld_field input[disabled],.ld_field select[disabled]{opacity:.55}
.ld_field .err{font-size:11.5px;color:var(--dsw-alias-state-error-primary)}
.ld_actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ld_btn{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:6px 12px}
.ld_btn:hover{border-color:var(--dsw-alias-state-business-primary)}
.ld_btn[disabled]{opacity:.5;cursor:default}
.ld_btn.primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-on-accent)}
.ld_btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.ld_btn.danger:hover{border-color:var(--dsw-alias-state-error-primary)}
.ld_msg{font-size:12px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ld_msg.ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);color:var(--dsw-alias-state-success-primary)}
.ld_msg.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary)}
.ld_msg.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 40%,transparent);color:var(--dsw-alias-state-warning-primary)}
.ld_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.ld_stat{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px}
.ld_stat b{display:block;font-size:18px;font-weight:600}
.ld_stat span{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ld_kv{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ld_kv code{font-size:11.5px}
.ld_fold{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px}
.ld_fold>summary{cursor:pointer;font-weight:500;color:var(--dsw-alias-label-secondary)}
.ld_fold[open]>summary{margin-bottom:10px}
.ld_fallback{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.ld_fallback .ld_actions{justify-content:flex-end}
.ld_small{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ld_head .grow,.ld_savebar .grow{flex:1}
.ld_inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ld_check{display:flex;gap:8px;align-items:flex-start;font-size:12.5px}
.ld_check input{margin-top:2px}
.ld_savebar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding-top:4px}
.ld_savebar .grow{flex:1}
`

    /* ── helpers ─────────────────────────────────────────────────────────── */

    function clone(value) {
      try {
        return JSON.parse(JSON.stringify(value))
      } catch {
        return value
      }
    }

    function deepEqual(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    function setIn(target, path, value) {
      if (path.length === 0) return value
      const [head, ...rest] = path
      const copy = Array.isArray(target) ? target.slice() : { ...(target || {}) }
      copy[head] = rest.length === 0 ? value : setIn(copy[head], rest, value)
      return copy
    }

    function getIn(target, path, fallback) {
      let node = target
      for (const key of path) {
        if (node === null || typeof node !== 'object') return fallback
        node = node[key]
      }
      return node === undefined ? fallback : node
    }

    function fmt(n) {
      const value = Number(n)
      if (!Number.isFinite(value)) return '—'
      return value >= 10000 ? value.toLocaleString() : String(value)
    }

    function fmtDate(ms) {
      if (!ms) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    function format(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars && vars[key] !== undefined ? String(vars[key]) : ''))
    }

    function useSnapshot(controller) {
      return useSyncExternalStore(
        useCallback(cb => controller.subscribe(cb), [controller]),
        useCallback(() => controller.getSnapshot(), [controller]),
        useCallback(() => controller.getSnapshot(), [controller]),
      )
    }

    /* ── small controls ──────────────────────────────────────────────────── */

    function Field({ label, hint, error, children }) {
      return h(
        'div',
        { className: 'ld_field' },
        h('label', null, label),
        children,
        hint ? h('div', { className: 'hint' }, hint) : null,
        error ? h('div', { className: 'err' }, error) : null,
      )
    }

    function TextInput({ value, onChange, disabled, placeholder, type }) {
      return h('input', {
        type: type || 'text',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: placeholder || '',
        disabled: Boolean(disabled),
        onChange: event => onChange(event.target.value),
        spellCheck: false,
      })
    }

    function NumberInput({ value, onChange, disabled, min, max }) {
      return h('input', {
        type: 'number',
        value: value === undefined || value === null ? '' : String(value),
        min: min === undefined ? undefined : String(min),
        max: max === undefined ? undefined : String(max),
        disabled: Boolean(disabled),
        onChange: event => {
          const raw = event.target.value
          onChange(raw === '' ? 0 : Number(raw))
        },
      })
    }

    function Select({ value, onChange, disabled, options }) {
      return h(
        'select',
        { value: value === undefined || value === null ? '' : String(value), disabled: Boolean(disabled), onChange: event => onChange(event.target.value) },
        options.map(option => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    function Checkbox({ checked, onChange, disabled, label }) {
      return h(
        'label',
        { className: 'ld_check' },
        h('input', { type: 'checkbox', checked: Boolean(checked), disabled: Boolean(disabled), onChange: event => onChange(event.target.checked) }),
        h('span', null, label),
      )
    }

    /* ── status API ──────────────────────────────────────────────────────── */

    async function apiFetch(path, options) {
      const response = await fetch('/api/local-delegate' + path, {
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(options && options.body ? { 'content-type': 'application/json' } : {}) },
        ...options,
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status)
      return payload
    }

    /* ── page ────────────────────────────────────────────────────────────── */

    function Page(props) {
      const { t, form, piForm, subForm } = props
      const snap = useSnapshot(form)
      const piSnap = useSnapshot(piForm)
      const subSnap = useSnapshot(subForm)

      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const dirtyRef = useRef(false)
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState('')
      const [probe, setProbe] = useState(null)
      const [models, setModels] = useState([])

      useEffect(() => {
        dirtyRef.current = dirty
      }, [dirty])

      useEffect(() => {
        if (snap.status !== 'ready') return
        if (dirtyRef.current) return
        setDraft(clone(snap.value))
      }, [snap.status, snap.revision])

      const saved = snap.status === 'ready' ? snap.value : null
      const writable = snapshotWritable(snap)
      const disabled = !writable || !draft
      const current = draft || saved || {}

      const refreshStatus = useCallback(async () => {
        try {
          const payload = await apiFetch('/status')
          setStatus(payload)
          setStatusError('')
        } catch (error) {
          setStatusError(String(error?.message ?? error))
        }
      }, [])

      useEffect(() => {
        void refreshStatus()
      }, [refreshStatus])

      const update = useCallback((path, value) => {
        setDraft(prev => setIn(prev || {}, path, value))
        setDirty(true)
        setMessage(null)
      }, [])

      const endpoint = current.endpoint || {}
      const setEndpoint = useCallback((key, value) => update(['endpoint', key], value), [update])
      const fallbacks = Array.isArray(current.fallbackEndpoints) ? current.fallbackEndpoints : []
      const setFallback = useCallback((index, key, value) => {
        setDraft(prev => {
          const list = Array.isArray(prev.fallbackEndpoints) ? prev.fallbackEndpoints.slice() : []
          list[index] = { ...(list[index] || {}), [key]: value }
          return { ...prev, fallbackEndpoints: list }
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const validate = useCallback(() => {
        if (!endpoint.baseURL || !/^https?:\/\/[^\s]+$/i.test(String(endpoint.baseURL))) {
          return { kind: 'err', text: t('baseURLHint') }
        }
        if (!String(endpoint.model || '').trim()) return { kind: 'err', text: t('modelHint') }
        for (const [index, fallback] of fallbacks.entries()) {
          if (fallback && fallback.baseURL && !/^https?:\/\/[^\s]+$/i.test(String(fallback.baseURL))) {
            return { kind: 'err', text: `fallback[${index}]: ${t('baseURLHint')}` }
          }
        }
        if (endpoint.headers !== undefined && endpoint.headers !== null) {
          if (typeof endpoint.headers !== 'object' || Array.isArray(endpoint.headers)) return { kind: 'err', text: t('headersHint') }
          for (const value of Object.values(endpoint.headers)) {
            if (typeof value !== 'string') return { kind: 'err', text: t('headersHint') }
          }
        }
        return null
      }, [endpoint, fallbacks, t])

      const save = useCallback(async () => {
        if (!saved || !draft) return
        const invalid = validate()
        if (invalid) {
          setMessage(invalid)
          return
        }
        const ops = buildOps(saved, draft)
        if (ops.length === 0) {
          setDirty(false)
          setMessage({ kind: 'ok', text: t('noChanges') })
          return
        }
        setBusy('save')
        setMessage(null)
        try {
          const accepted = await form.mutate(ops, snap.revision)
          if (!accepted) {
            setMessage({ kind: 'err', text: t('saveFailed') })
            return
          }
          setDirty(false)
          setMessage({ kind: 'ok', text: t('saved') })
          void refreshStatus()
        } catch (error) {
          setMessage({ kind: 'err', text: t('saveFailed') + ' ' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [draft, form, refreshStatus, saved, snap.revision, t, validate])

      const discard = useCallback(() => {
        if (!saved) return
        setDraft(clone(saved))
        setDirty(false)
        setMessage(null)
      }, [saved])

      const resetAll = useCallback(() => {
        if (!snap.base) return
        setDraft(clone(snap.base))
        setDirty(true)
        setMessage({ kind: 'warn', text: t('resetAll') })
      }, [snap.base, t])

      const runProbe = useCallback(
        async (wantModels) => {
          if (!draft || !draft.endpoint) return
          setBusy(wantModels ? 'models' : 'probe')
          setProbe(null)
          setMessage(null)
          try {
            const payload = await apiFetch('/probe', {
              method: 'POST',
              body: JSON.stringify({ endpoint: draft.endpoint }),
            })
            setProbe(payload)
            if (wantModels && Array.isArray(payload.models)) {
              setModels(payload.models)
              if (payload.models.length === 0) setMessage({ kind: 'warn', text: t('modelsEmpty') })
            }
          } catch (error) {
            setProbe({ ok: false, error: String(error?.message ?? error) })
          } finally {
            setBusy('')
          }
        },
        [draft, t],
      )

      const piReady = piSnap.status === 'ready'
      const subReady = subSnap.status === 'ready'
      const routeRegistered = Boolean(piReady && piSnap.value && piSnap.value.providers && piSnap.value.providers[ROUTE_PROVIDER])
      const subAllowed = Boolean(
        subReady &&
          subSnap.value &&
          subSnap.value.enabled === true &&
          Array.isArray(subSnap.value.allowedModels) &&
          subSnap.value.allowedModels.some(route => route && route.provider === ROUTE_PROVIDER),
      )

      const enableSubagentRoute = useCallback(async () => {
        if (!saved || dirty) {
          setMessage({ kind: 'warn', text: t('subagentNeedsSave') })
          return
        }
        const model = String(saved.endpoint.model || '').trim()
        if (!model) {
          setMessage({ kind: 'warn', text: t('subagentNeedsModel') })
          return
        }
        if (!piReady || !subReady) {
          setMessage({ kind: 'warn', text: t('subagentUnavailable') })
          return
        }
        setBusy('subagent')
        setMessage(null)
        try {
          const provider = buildPiProvider(saved.endpoint)
          const piOk = await piForm.mutate([{ op: 'set', path: ['providers', ROUTE_PROVIDER], value: provider }], piSnap.revision)
          if (!piOk) {
            setMessage({ kind: 'err', text: t('subagentFailed') })
            return
          }
          const currentRoutes = Array.isArray(subSnap.value.allowedModels) ? subSnap.value.allowedModels : []
          const routes = currentRoutes
            .filter(route => route && route.provider !== ROUTE_PROVIDER)
            .concat([{ provider: ROUTE_PROVIDER, model }])
          const subOk = await subForm.mutate(
            [
              { op: 'set', path: ['enabled'], value: true },
              { op: 'set', path: ['allowedModels'], value: routes },
            ],
            subSnap.revision,
          )
          setMessage({ kind: subOk ? 'ok' : 'err', text: subOk ? t('subagentDone') : t('subagentFailed') })
          void refreshStatus()
        } catch (error) {
          setMessage({ kind: 'err', text: t('subagentFailed') + ' ' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [dirty, piForm, piReady, piSnap, refreshStatus, saved, subForm, subReady, subSnap, t])

      const disableSubagentRoute = useCallback(async () => {
        if (!piReady || !subReady) return
        setBusy('subagent')
        setMessage(null)
        try {
          if (routeRegistered) {
            await piForm.mutate([{ op: 'unset', path: ['providers', ROUTE_PROVIDER] }], piSnap.revision)
          }
          const currentRoutes = Array.isArray(subSnap.value.allowedModels) ? subSnap.value.allowedModels : []
          const routes = currentRoutes.filter(route => route && route.provider !== ROUTE_PROVIDER)
          await subForm.mutate(
            [
              { op: 'set', path: ['allowedModels'], value: routes },
              { op: 'set', path: ['enabled'], value: routes.length > 0 },
            ],
            subSnap.revision,
          )
          setMessage({ kind: 'ok', text: t('subagentRemoved') })
          void refreshStatus()
        } catch (error) {
          setMessage({ kind: 'err', text: t('subagentFailed') + ' ' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [piForm, piReady, piSnap, refreshStatus, routeRegistered, subForm, subReady, subSnap, t])

      if (snap.status === 'loading') return h('div', { className: 'ld_root' }, h('div', { className: 'ld_msg' }, t('loading')))
      if (snap.status === 'unavailable') return h('div', { className: 'ld_root' }, h('div', { className: 'ld_msg warn' }, t('unavailable')))
      if (!saved || !draft) return h('div', { className: 'ld_root' }, h('div', { className: 'ld_msg' }, t('loading')))

      const health = status && status.health ? status.health : null
      const stats = status && status.stats ? status.stats : null
      const policyConfig = status && status.config ? status.config : null
      const healthStatus = health ? health.status : 'unknown'
      const badgeClass = healthStatus === 'available' ? 'ok' : healthStatus === 'degraded' ? 'warn' : healthStatus === 'unavailable' ? 'err' : ''

      return h(
        'div',
        { className: 'ld_root' },
        h(
          'div',
          { className: 'ld_head' },
          h('h2', null, t('title')),
          h('span', { className: 'ld_badge ' + badgeClass }, healthStatus === 'available' ? t('healthAvailable') : healthStatus === 'degraded' ? t('healthDegraded') : healthStatus === 'unavailable' ? t('healthUnavailable') : t('healthUnknown')),
          dirty ? h('span', { className: 'ld_badge warn' }, t('dirty')) : null,
          !writable ? h('span', { className: 'ld_badge' }, t('readonly')) : null,
        ),
        h('p', { className: 'ld_sub' }, t('subtitle')),

        message ? h('div', { className: 'ld_msg ' + (message.kind || '') }, message.text) : null,
        statusError ? h('div', { className: 'ld_msg err' }, format(t('statusFailed'), { error: statusError })) : null,

        h(HealthCard, { t, health, status, onRefresh: refreshStatus, busy }),

        h(
          'section',
          { className: 'ld_card' },
          h('h3', null, t('endpointSection')),
          h(
            'div',
            { className: 'ld_row' },
            h(
              Field,
              { label: t('kind') },
              h(Select, {
                value: endpoint.kind || 'ollama-native',
                disabled,
                options: [
                  { value: 'ollama-native', label: t('kindOllama') },
                  { value: 'openai-compatible', label: t('kindOpenAI') },
                ],
                onChange: value => setEndpoint('kind', value),
              }),
            ),
            h(
              Field,
              { label: t('baseURL'), hint: t('baseURLHint') },
              h(TextInput, { value: endpoint.baseURL, disabled, onChange: value => setEndpoint('baseURL', value) }),
            ),
          ),
          h(
            'div',
            { className: 'ld_row' },
            h(
              Field,
              { label: t('model'), hint: t('modelHint') },
              h('div', { className: 'ld_inline' },
                h(TextInput, { value: endpoint.model, disabled, placeholder: 'gemma4:e2b', onChange: value => setEndpoint('model', value) }),
                models.length > 0
                  ? h(
                      Select,
                      {
                        value: endpoint.model || '',
                        disabled,
                        options: [{ value: endpoint.model || '', label: t('model') + '…' }].concat(
                          models.map(name => ({ value: name, label: name })),
                        ),
                        onChange: value => setEndpoint('model', value),
                      },
                    )
                  : null,
              ),
            ),
            h(
              Field,
              { label: t('apiKey'), hint: t('apiKeyHint') },
              h(TextInput, { value: endpoint.apiKey, disabled, type: 'password', onChange: value => setEndpoint('apiKey', value) }),
            ),
          ),
          h(
            'div',
            { className: 'ld_row' },
            h(
              Field,
              { label: t('apiKeyEnv'), hint: t('apiKeyEnvHint') },
              h(TextInput, { value: endpoint.apiKeyEnv, disabled, placeholder: 'LOCAL_MODEL_API_KEY', onChange: value => setEndpoint('apiKeyEnv', value) }),
            ),
            h(
              Field,
              { label: t('timeoutMs') },
              h(NumberInput, { value: endpoint.timeoutMs, disabled, min: 1000, onChange: value => setEndpoint('timeoutMs', value) }),
            ),
          ),
          h(
            'div',
            { className: 'ld_actions' },
            h('button', { type: 'button', className: 'ld_btn', disabled: disabled || busy === 'probe', onClick: () => void runProbe(false) }, busy === 'probe' ? t('testing') : t('test')),
            h('button', { type: 'button', className: 'ld_btn', disabled: disabled || busy === 'models', onClick: () => void runProbe(true) }, busy === 'models' ? t('testing') : t('models')),
            h('span', { className: 'ld_small' }, t('testHint')),
          ),
          probe ? h(ProbeResult, { t, probe }) : null,

          h(
            'details',
            { className: 'ld_fold' },
            h('summary', null, t('advanced')),
            h(
              'div',
              { className: 'ld_row', style: { marginTop: '10px' } },
              h(Field, { label: t('path'), hint: t('pathHint') }, h(TextInput, { value: endpoint.path, disabled, onChange: value => setEndpoint('path', value) })),
              h(
                Field,
                { label: t('think'), hint: t('thinkHint') },
                h(Checkbox, { checked: endpoint.think === true, disabled, label: t('think'), onChange: value => setEndpoint('think', value) }),
              ),
            ),
            h(
              'div',
              { className: 'ld_row', style: { marginTop: '10px' } },
              h(
                Field,
                { label: t('reasoningEffort'), hint: t('reasoningEffortHint') },
                h(Select, {
                  value: endpoint.reasoningEffort || 'none',
                  disabled,
                  options: [
                    { value: 'none', label: 'none' },
                    { value: 'low', label: 'low' },
                    { value: 'medium', label: 'medium' },
                    { value: 'high', label: 'high' },
                  ],
                  onChange: value => setEndpoint('reasoningEffort', value),
                }),
              ),
              h(Field, { label: t('numCtx') }, h(NumberInput, { value: endpoint.numCtx, disabled, min: 512, onChange: value => setEndpoint('numCtx', value) })),
              h(Field, { label: t('keepAlive'), hint: t('keepAliveHint') }, h(TextInput, { value: endpoint.keepAlive, disabled, onChange: value => setEndpoint('keepAlive', value) })),
            ),
            h(
              'div',
              { className: 'ld_row', style: { marginTop: '10px' } },
              h(Field, { label: t('temperature') }, h(NumberInput, { value: endpoint.temperature, disabled, min: 0, max: 2, onChange: value => setEndpoint('temperature', value) })),
              h(Field, { label: t('maxOutputTokens') }, h(NumberInput, { value: endpoint.maxOutputTokens, disabled, min: 1, onChange: value => setEndpoint('maxOutputTokens', value) })),
            ),
            h(
              'div',
              { style: { marginTop: '10px' } },
              h(
                Field,
                { label: t('headers'), hint: t('headersHint') },
                h('textarea', {
                  rows: 3,
                  value: JSON.stringify(endpoint.headers || {}, null, 2),
                  disabled,
                  onChange: event => {
                    try {
                      const parsed = JSON.parse(event.target.value)
                      setEndpoint('headers', parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
                    } catch {
                      /* keep the previous value until the JSON is valid */
                    }
                  },
                }),
              ),
            ),
          ),
        ),

        h(
          'section',
          { className: 'ld_card' },
          h('h3', null, t('fallback')),
          h('div', { className: 'ld_small' }, t('fallbackHint')),
          fallbacks.map((fallback, index) =>
            h(
              'div',
              { className: 'ld_fallback', key: 'fallback-' + index },
              h(
                'div',
                { className: 'ld_row' },
                h(
                  Field,
                  { label: t('kind') },
                  h(Select, {
                    value: fallback.kind || 'ollama-native',
                    disabled,
                    options: [
                      { value: 'ollama-native', label: t('kindOllama') },
                      { value: 'openai-compatible', label: t('kindOpenAI') },
                    ],
                    onChange: value => setFallback(index, 'kind', value),
                  }),
                ),
                h(Field, { label: t('baseURL') }, h(TextInput, { value: fallback.baseURL, disabled, onChange: value => setFallback(index, 'baseURL', value) })),
                h(Field, { label: t('model') }, h(TextInput, { value: fallback.model, disabled, onChange: value => setFallback(index, 'model', value) })),
                h(Field, { label: t('timeoutMs') }, h(NumberInput, { value: fallback.timeoutMs, disabled, min: 1000, onChange: value => setFallback(index, 'timeoutMs', value) })),
              ),
              h(
                'div',
                { className: 'ld_actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ld_btn danger',
                    disabled,
                    onClick: () => {
                      setDraft(prev => ({ ...prev, fallbackEndpoints: (prev.fallbackEndpoints || []).filter((_, i) => i !== index) }))
                      setDirty(true)
                    },
                  },
                  t('remove'),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ld_actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'ld_btn',
                disabled,
                onClick: () => {
                  setDraft(prev => ({
                    ...prev,
                    fallbackEndpoints: (prev.fallbackEndpoints || []).concat([
                      {
                        kind: prev.endpoint.kind,
                        baseURL: '',
                        model: '',
                        timeoutMs: 240000,
                      },
                    ]),
                  }))
                  setDirty(true)
                },
              },
              t('addFallback'),
            ),
          ),
        ),

        h(
          'section',
          { className: 'ld_card' },
          h('h3', null, t('limits')),
          h(
            'div',
            { className: 'ld_row' },
            h(Field, { label: t('retries') }, h(NumberInput, { value: current.retries, disabled, min: 0, max: 3, onChange: value => update(['retries'], value) })),
            h(Field, { label: t('chunkChars') }, h(NumberInput, { value: current.chunkChars, disabled, min: 500, onChange: value => update(['chunkChars'], value) })),
            h(Field, { label: t('maxConcurrency') }, h(NumberInput, { value: current.maxConcurrency, disabled, min: 1, max: 8, onChange: value => update(['maxConcurrency'], value) })),
          ),
          h(
            'div',
            { className: 'ld_row' },
            h(Field, { label: t('maxInlineChars') }, h(NumberInput, { value: current.maxInlineChars, disabled, min: 100, onChange: value => update(['maxInlineChars'], value) })),
            h(Field, { label: t('maxBatchFiles') }, h(NumberInput, { value: current.maxBatchFiles, disabled, min: 1, onChange: value => update(['maxBatchFiles'], value) })),
            h(Field, { label: t('maxBatchChars') }, h(NumberInput, { value: current.maxBatchChars, disabled, min: 1000, onChange: value => update(['maxBatchChars'], value) })),
          ),
          h(
            'div',
            { className: 'ld_row' },
            h(Field, { label: t('maxSourceChars') }, h(NumberInput, { value: current.maxSourceChars, disabled, min: 1000, onChange: value => update(['maxSourceChars'], value) })),
            h(Field, { label: t('maxResultChars') }, h(NumberInput, { value: current.maxResultChars, disabled, min: 100, onChange: value => update(['maxResultChars'], value) })),
            h(Field, { label: t('maxCallsPerMinute') }, h(NumberInput, { value: current.maxCallsPerMinute, disabled, min: 1, onChange: value => update(['maxCallsPerMinute'], value) })),
          ),
          h(
            'div',
            { className: 'ld_actions' },
            h(Checkbox, { checked: current.promptHelp === true, disabled, label: t('promptHelp'), onChange: value => update(['promptHelp'], value) }),
            h(Checkbox, { checked: current.warmupOnStart === true, disabled, label: t('warmupOnStart'), onChange: value => update(['warmupOnStart'], value) }),
            h(Checkbox, { checked: current.probeAllowPublic === true, disabled, label: t('probeAllowPublic'), onChange: value => update(['probeAllowPublic'], value) }),
          ),
          h('div', { className: 'ld_small' }, t('probeAllowPublicHint')),
          h('div', { className: 'ld_small' }, t('policy') + ': ' + t('policyHint')),
          h(
            'div',
            { className: 'ld_kv' },
            h('span', null, 'allowOutsideCwd: ', h('code', null, String(policyConfig && policyConfig.allowOutsideCwd === true))),
            h('span', null, 'allowRoots: ', h('code', null, JSON.stringify((policyConfig && policyConfig.allowRoots) || []))),
            h('span', null, 'denyGlobs: ', h('code', null, String(((policyConfig && policyConfig.denyGlobs) || []).length) + ' pattern(s)')),
          ),
        ),

        h(SubagentCard, {
          t,
          piReady,
          subReady,
          routeRegistered,
          subAllowed,
          busy,
          onEnable: enableSubagentRoute,
          onDisable: disableSubagentRoute,
          savedEndpoint: saved.endpoint,
        }),

        h(StatsCard, { t, stats, onRefresh: refreshStatus }),

        h(
          'div',
          { className: 'ld_savebar' },
          h('button', { type: 'button', className: 'ld_btn primary', disabled: disabled || busy === 'save' || !dirty, onClick: () => void save() }, busy === 'save' ? t('saving') : t('save')),
          h('button', { type: 'button', className: 'ld_btn', disabled: disabled || !dirty || busy === 'save', onClick: discard }, t('discard')),
          h('button', { type: 'button', className: 'ld_btn', disabled: disabled || busy === 'save', onClick: resetAll }, t('resetAll')),
          h('span', { className: 'grow' }),
          h('span', { className: 'ld_small' }, 'local-delegate'),
        ),
      )
    }

    function snapshotWritable(snap) {
      return snap && snap.writable !== false && snap.status === 'ready'
    }

    function buildOps(saved, draft) {
      const ops = []
      if (!deepEqual(saved.endpoint, draft.endpoint)) ops.push({ op: 'set', path: ['endpoint'], value: draft.endpoint })
      if (!deepEqual(saved.fallbackEndpoints, draft.fallbackEndpoints)) ops.push({ op: 'set', path: ['fallbackEndpoints'], value: draft.fallbackEndpoints })
      for (const field of [
        'retries',
        'chunkChars',
        'maxConcurrency',
        'maxInlineChars',
        'maxSourceChars',
        'maxBatchFiles',
        'maxBatchChars',
        'maxResultChars',
        'maxCallsPerMinute',
        'promptHelp',
        'warmupOnStart',
        'probeAllowPublic',
      ]) {
        if (!deepEqual(saved[field], draft[field])) ops.push({ op: 'set', path: [field], value: draft[field] })
      }
      if (!deepEqual(saved.modelsByTask, draft.modelsByTask)) ops.push({ op: 'set', path: ['modelsByTask'], value: draft.modelsByTask })
      return ops
    }

    function buildPiProvider(endpoint) {
      const raw = String(endpoint.baseURL || '').trim().replace(/\/+$/, '')
      const baseURL = /\/v\d+$/.test(raw) ? raw : raw + '/v1'
      const headers = { ...(endpoint.headers || {}) }
      if (endpoint.apiKey) headers.Authorization = 'Bearer ' + endpoint.apiKey
      else if (!headers.Authorization && (!endpoint.kind || endpoint.kind === 'ollama-native')) headers.Authorization = 'Bearer ollama'
      const provider = {
        displayName: '本地/降智模型（dsh-local-delegate）',
        api: 'openai-completions',
        baseURL,
        models: [{ id: String(endpoint.model || '').trim() }],
        defaultContextWindow: Number(endpoint.numCtx) || 32768,
        defaultMaxTokens: Number(endpoint.maxOutputTokens) || 4096,
      }
      if (Object.keys(headers).length > 0) provider.headers = headers
      else if (endpoint.apiKeyEnv) provider.apiKeyEnv = endpoint.apiKeyEnv
      return provider
    }

    function HealthCard({ t, health, status, onRefresh, busy }) {
      const state = health ? health.status : 'unknown'
      const label = state === 'available' ? t('healthAvailable') : state === 'degraded' ? t('healthDegraded') : state === 'unavailable' ? t('healthUnavailable') : t('healthUnknown')
      const badge = state === 'available' ? 'ok' : state === 'degraded' ? 'warn' : state === 'unavailable' ? 'err' : ''
      const effective = health && health.effective ? health.effective : health && health.primary ? health.primary : null
      const savedConfig = status && status.config ? status.config : null
      return h(
        'section',
        { className: 'ld_card' },
        h(
          'div',
          { className: 'ld_head' },
          h('h3', null, t('health')),
          h('span', { className: 'ld_badge ' + badge }, label),
          health && health.checkedAt ? h('span', { className: 'ld_small' }, t('healthChecked') + ': ' + fmtDate(health.checkedAt)) : null,
          h('span', { className: 'grow' }),
          h('button', { type: 'button', className: 'ld_btn', disabled: busy === 'probe', onClick: () => void onRefresh() }, t('refresh')),
        ),
        savedConfig
          ? h(
              'div',
              { className: 'ld_kv' },
              h('span', null, t('kind') + ': ', h('code', null, savedConfig.endpoint.kind)),
              h('span', null, t('baseURL') + ': ', h('code', null, savedConfig.endpoint.baseURL)),
              h('span', null, t('model') + ': ', h('code', null, savedConfig.endpoint.model || '(unset)')),
              h('span', null, t('apiKey') + ': ', h('code', null, savedConfig.endpoint.apiKeyConfigured ? 'configured' : 'not set')),
              savedConfig.endpoint.apiKeyEnv ? h('span', null, t('apiKeyEnv') + ': ', h('code', null, savedConfig.endpoint.apiKeyEnv)) : null,
            )
          : null,
        effective
          ? h(
              'div',
              { className: 'ld_kv' },
              h('span', null, t('healthEffective') + ': ', h('code', null, effective.baseURL + ' · ' + (effective.model || ''))),
              effective.latencyMs !== null && effective.latencyMs !== undefined ? h('span', null, t('healthLatency') + ': ', h('code', null, String(effective.latencyMs) + 'ms')) : null,
              effective.error ? h('span', null, h('code', null, String(effective.error).slice(0, 180))) : null,
            )
          : null,
      )
    }

    function ProbeResult({ t, probe }) {
      if (!probe) return null
      const model = probe.endpoint ? String(probe.endpoint).split('/').pop() : ''
      const lines = []
      if (probe.ok) {
        lines.push(format(t('probeOk'), { ms: probe.latencyMs }))
        if (probe.modelFound) lines.push(format(t('probeModelFound'), { model: model || (probe.models && probe.models[0]) || '' }))
        else if (probe.models && probe.models.length > 0) lines.push(format(t('probeModelMissing'), { model }) + ' (' + probe.models.slice(0, 6).join(', ') + ')')
      } else {
        lines.push(format(t('probeFailed'), { error: probe.error || '' }))
      }
      return h('div', { className: 'ld_msg ' + (probe.ok ? (probe.modelFound ? 'ok' : 'warn') : 'err') }, lines.join(' '))
    }

    function SubagentCard({ t, piReady, subReady, routeRegistered, subAllowed, busy, onEnable, onDisable, savedEndpoint }) {
      const available = piReady && subReady
      const active = routeRegistered && subAllowed
      return h(
        'section',
        { className: 'ld_card' },
        h('h3', null, t('subagent')),
        h('div', { className: 'ld_small' }, t('subagentHint')),
        h(
          'div',
          { className: 'ld_kv' },
          h('span', null, t('pid') + ': ', h('code', null, ROUTE_PROVIDER)),
          h('span', null, t('model') + ': ', h('code', null, (savedEndpoint && savedEndpoint.model) || '(unset)')),
          h('span', null, active ? t('subagentEnabled') : available ? t('subagentNotEnabled') : t('subagentUnavailable')),
        ),
        h(
          'div',
          { className: 'ld_actions' },
          available
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ld_btn' + (active ? ' danger' : ' primary'),
                  disabled: busy === 'subagent',
                  onClick: () => void (active ? onDisable() : onEnable()),
                },
                busy === 'subagent' ? t('saving') : active ? t('subagentDisable') : t('subagentEnable'),
              )
            : null,
        ),
        h('div', { className: 'ld_small' }, 'llm-pi-ai: ' + (piReady ? 'ready' : 'unavailable') + ' · ' + 'subagent-model-selection-settings: ' + (subReady ? 'ready' : 'unavailable')),
      )
    }

    function StatsCard({ t, stats, onRefresh }) {
      return h(
        'section',
        { className: 'ld_card' },
        h(
          'div',
          { className: 'ld_head' },
          h('h3', null, t('stats')),
          h('span', { className: 'grow' }),
          h('button', { type: 'button', className: 'ld_btn', onClick: () => void onRefresh() }, t('refresh')),
        ),
        h('div', { className: 'ld_small' }, t('statsHint')),
        stats && stats.calls + stats.failed > 0
          ? h(
              'div',
              { className: 'ld_grid' },
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.calls)), h('span', null, t('statsCalls'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.failed)), h('span', null, t('statsFailed'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.chunkCalls)), h('span', null, t('statsRequests'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.charsIn + stats.charsOut)), h('span', null, t('statsChars'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.localPromptTokens + stats.localCompletionTokens)), h('span', null, t('statsLocalTokens'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.estimatedSavedTokens)), h('span', null, t('statsSaved'))),
            )
          : h('div', { className: 'ld_msg' }, t('statsEmpty')),
        stats
          ? h(
              'div',
              { className: 'ld_kv' },
              h('span', null, t('statsSince') + ': ', h('code', null, fmtDate(stats.startedAt))),
              stats.lastError ? h('span', null, t('statsLastError') + ': ', h('code', null, String(stats.lastError).slice(0, 180))) : null,
            )
          : null,
        stats && stats.byTask && Object.keys(stats.byTask).length > 0
          ? h(
              'div',
              { className: 'ld_kv' },
              Object.keys(stats.byTask)
                .sort()
                .slice(0, 8)
                .map(task =>
                  h('span', { key: task }, h('code', null, TASK_LABELS[task] || task) + ' ×' + fmt(stats.byTask[task].calls)),
                ),
            )
          : null,
      )
    }

    /* ── plugin entry ────────────────────────────────────────────────────── */

    function apply(ctx) {
      const tr = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'local-delegate: dictionaries')

      const configForms = ctx.configForms
      const form = configForms.get(CONFIG_NS)
      const piForm = configForms.get(PI_NS)
      const subForm = configForms.get(SUBAGENT_NS)
      ctx.effect(
        () => () => {
          void form.dispose()
          void piForm.dispose()
          void subForm.dispose()
        },
        'local-delegate: settings forms',
      )

      ctx.effect(
        () => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-local-delegate', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        },
        'local-delegate: styles',
      )

      const pageProps = { t: tr, form, piForm, subForm }

      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.row.config',
            key: 'dsh-local-delegate#local-delegate',
            locale: NS,
          },
          props => (props.view === 'summary' ? tr('summary') : h(Page, Object.assign({}, pageProps, { view: props.view }))),
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'local-delegate',
            order: 34,
            label: () => tr('nav'),
            locale: NS,
          },
          props => h(Page, Object.assign({}, pageProps, { close: props.close })),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'configForms']
    exports.name = 'local-delegate-settings'
    exports.Page = Page
    exports.__test = { Page, HealthCard, ProbeResult, SubagentCard, StatsCard, buildOps, buildPiProvider }
    return module.exports
  },
})




