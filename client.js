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

    /* ── 0.4.0 contract constants ────────────────────────────────────────── */

    const LEVEL_VALUES = ['none', 'light', 'default', 'high', 'max']
    const PLANNER_FALLBACK_VALUES = ['strong-worker', 'fail']
    const SLAVE_KINDS = ['local', 'cloud']
    const SLAVE_FALLBACK_VALUES = ['inherit', 'fail']
    const SLAVE_TOOLS = [
      'slave_team_spawn',
      'slave_team_status',
      'slave_team_wait',
      'slave_team_send',
      'slave_team_interrupt',
    ]
    const MAX_SLAVES = 8
    const MAX_SLAVE_NODES = 12

    /**
     * v0.4 config fields written by buildOps, in the exact order required by
     * the implementation contract (§9.3). `whole: true` fields are objects or
     * arrays stored with one whole-value set op.
     */
    const V04_FIELDS = [
      ['levelsEnabled', false],
      ['defaultLevel', false],
      ['workspaceLevels', true],
      ['workerProvider', false],
      ['workerPreset', false],
      ['workerRouteProvider', false],
      ['workerRouteModel', false],
      ['workerMaxDepth', false],
      ['lightMinChars', false],
      ['lightMinFiles', false],
      ['highMinChars', false],
      ['plannerAllowRead', false],
      ['plannerFallback', false],
      ['plannerDenyExtra', true],
      ['plannerAllowExtra', true],
      ['applyToLiveAgents', false],
      ['composerLevelPicker', false],
      ['slaveTeamsEnabled', false],
      ['slaveNodes', true],
      ['slaveTeamDefaultNode', false],
      ['slaveTeamProvider', false],
      ['slaveTeamPreset', false],
      ['slaveTeamMaxSlaves', false],
      ['slaveTeamMaxDepth', false],
      ['slaveTeamFallback', false],
      ['slaveTeamPromptHelp', false],
      ['slaveTeamAutoDiscover', false],
    ]

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
      endpointNumberInvalid: '{field} must be a number between {min} and {max}.',
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
      limits: 'Advanced limits (usually not needed)',
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
      healthFallback: 'fallback',
      healthOnline: 'online',
      healthOffline: 'offline',
      healthModelMissing: 'reachable, model missing',
      healthEndpoints: 'Endpoint chain',
      healthNoFallbacks: 'No fallback endpoint configured.',
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
      statsWorkers: 'local_worker starts',
      statsWorkersFailed: 'worker failures',
      statsSlaves: 'slaves started',
      statsSlavesSettled: 'slaves settled',
      statsSlavesFailed: 'slave failures',
      statsByNode: 'slave starts by node',
      subagent: 'Use as a Subagent / model-picker route',
      subagentHint:
        'This is an action button, not a live toggle: clicking it registers this endpoint in the DSH model catalog as provider “local-delegate” (via llm-pi-ai) and allows that route for Subagent model selection. The Subagent policy is sampled when a new session is composed, so open a new session to use it. The result appears directly below the button.',
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
      levels: 'Local AI involvement',
      levelsHint:
        'Applies per workspace on new sessions. Default = current behavior; High prefers the local model for mechanical chunks and exposes local_worker; Max makes the main agent plan only and hand every edit or command to local workers. Team teammates still run on the strong model. Turn on “Apply to live agents” to reinstall running sessions.',
      levelsEnabled: 'Enable the level policy',
      levelsEnabledHint: 'Off = every workspace resolves to “default” (v0.3 behavior) no matter what is selected below.',
      levelsDefault: 'Default level',
      levelsDefaultHint: 'Used for workspaces without an override and for sessions whose workspace cannot be matched.',
      levelNone: 'None (no local model)',
      levelLight: 'Light (long/batch work only)',
      levelDefault: 'Default (current behavior)',
      levelHigh: 'High (prefer local)',
      levelMax: 'Max (plan only)',
      levelsInherit: 'Follow default',
      levelsWorkspaces: 'Workspaces',
      levelsWorkspacesHint: 'Per-workspace overrides. Paths come from the Host canonical workspace registry; matching ignores case and slash style.',
      levelsNoWorkspaces: 'No workspaces found (workspaceRegistry not mounted, or none open yet).',
      levelsNoWorkspacesHint: 'Open a workspace in DSH, then refresh this list.',
      levelsUnavailable: 'The Host does not serve /levels yet (older plugin version, or the workspace registry is unavailable).',
      levelsRefresh: 'Refresh workspaces',
      levelsLoadFailed: 'Workspace list failed: {error}',
      levelsAdvanced: 'Advanced level settings',
      levelsNeedsRoute: 'Level high/max needs the “local-delegate” route in llm-pi-ai. Click “Enable for Subagent” above first, then open a new session.',
      levelsTeamNote: 'Agent Teams teammates still run on the strong model (DSH Team spawn takes no model parameter); only local workers are local.',
      levelsDisabledNote: 'The level policy is off: every workspace resolves to “default” (v0.3 behavior).',
      composerLevel: 'Show level picker in the composer',
      composerLevelHint: 'Show a compact “Local AI involvement” picker in the composer tool row, next to the model / reasoning controls. It edits the current workspace override, or the default level when the session has no workspace.',
      composerLevelShort: 'Local AI',
      composerLevelTitle: 'Local AI involvement (current workspace)',
      composerLevelMenuTitle: 'Local AI involvement',
      composerLevelWorkspace: 'Workspace',
      composerLevelDefaultMode: 'This session is not attached to a workspace — this edits the global default level.',
      composerLevelInherit: 'Follow default',
      composerLevelNewSession: 'Applies to new sessions.',
      composerLevelConflict: 'The config changed in another editor; try again.',
      composerLevelSaveFailed: 'Save failed: {error}',
      levelsInvalid: 'Default level must be one of none/light/default/high/max.',
      levelsInvalidWorkspace: 'Invalid workspace level for: ',
      levelsThresholdInvalid: 'Thresholds must be positive integers.',
      workerProvider: 'Worker subagent provider',
      workerProviderHint: 'Subagent provider used to start local_worker children (default spawn).',
      workerPreset: 'Worker agent preset',
      workerPresetHint: 'Agent preset used by local_worker children (default standard).',
      workerRouteProvider: 'Worker LLM route provider',
      workerRouteProviderHint: 'LLM route of local workers (created by “Enable for Subagent”, default local-delegate).',
      workerRouteModel: 'Worker route model',
      workerRouteModelHint: 'Empty = use the endpoint model above.',
      workerMaxDepth: 'Worker max depth',
      workerMaxDepthHint: '1–5; how deep worker children may spawn.',
      lightMinChars: 'Light min chars',
      lightMinCharsHint: 'At level light, only files at least this large are delegated.',
      lightMinFiles: 'Light min files',
      lightMinFilesHint: 'At level light, a batch must contain at least this many files.',
      highMinChars: 'High min chars',
      highMinCharsHint: 'At level high, inline text of at least this size may be delegated.',
      plannerAllowRead: 'At max, planners may read files',
      plannerAllowReadHint: 'Keep read/glob/grep available for planning; turn off for the strictest isolation.',
      plannerFallback: 'Planner worker failure',
      plannerFallbackStrong: 'Retry with the strong model (costly, guarantees completion)',
      plannerFallbackFail: 'Fail and return the error',
      plannerDenyExtra: 'Extra denied tools (comma separated)',
      plannerAllowExtra: 'Extra allowed tools (comma separated)',
      plannerListHint: 'Comma-separated tool names, for example bash, write.',
      applyToLiveAgents: 'Apply to live agents now',
      applyToLiveAgentsHint: 'Reinstall scoped prompts/tools for running agents when settings change (may lose some prompt cache).',
      slaveTeams: 'SlaveAgentTeams (multi-node parallel)',
      slaveTeamsHint:
        'Enable a node pool and five slave_team_* tools for root/Team-Lead agents: spawn several slave child agents in parallel, each on a local cheap model or a cloud route, then wait for and collect the results. Compatible with native Agent Teams: teammates stay on the strong model and slaves never appear in the team roster.',
      slaveTeamsShortHint: 'Run independent tasks on cheap local or cloud slave subagents. Slaves are children, not Team teammates.',
      slaveTeamsEnable: 'Enable SlaveAgentTeams tools',
      slaveTeamsEnableHint: 'Only root agents (and Team Leads) receive the slave_team_* tools; child agents and teammates never do.',
      slaveAutoDiscover: 'Auto-detect all available endpoints and fallback endpoints (recommended)',
      slaveAutoDiscoverHint:
        'One switch: the root agent discovers every mounted LLM route/model when spawning, prefers local routes, and retries a failed node on the next one. Cloud routes stay available as failover unless named explicitly. The endpoint chain (primary + fallbacks) is registered as llm-pi-ai routes automatically on save.',
      slaveAutoMode: 'Automatic mode',
      slaveAutoNodes: 'Detected nodes',
      slaveAutoEmpty: 'No LLM route detected yet. Save once so the endpoint chain is registered as routes, then refresh detection.',
      slaveAutoRefresh: 'Refresh detection',
      slaveAutoDetected: 'Detected {count} route(s), {nodes} node(s) in the spawn pool.',
      slaveAutoIssues: 'Discovery notes: {issues}',
      slaveAutoRoutesSync: 'Registered {count} endpoint-chain route(s) in llm-pi-ai.',
      slaveAutoRoutesFailed: 'Endpoint-chain routes could not be registered automatically: {error}',
      slaveAutoSyncNow: 'Register endpoint-chain routes now',
      slaveAutoOffHint: 'Automatic discovery is off; the node pool below is used as configured.',
      slaveAvailable: 'Available nodes',
      slaveAvailableHint:
        'Tick the nodes to include in SlaveAgentTeams. It shows the endpoint-chain routes by default; other mounted routes are summarized below. If nothing is ticked, automatic mode uses every detected node. At workspace level "none", local nodes are not used.',
      slaveAvailableSelected: '{selected}/{total} selected',
      slaveAvailableRouteHint:
        'The list counts LLM route/model pairs, not endpoints: one endpoint can expose several models, and the same model can appear again under a different provider.',
      slaveOtherRoutesHint:
        '{count} other mounted route(s) are not part of the endpoint chain and are hidden here ({providers}); add them with the advanced node editor only when needed.',
      slaveCleanNodes: 'Clean invalid/duplicate nodes',
      slaveAvailableEmpty: 'No available nodes detected yet. Save the endpoint chain, register the routes, then refresh detection.',
      slaveSelectAll: 'Select all available',
      slaveManualSelection: 'A manual node selection is active. Use "Select all available" to include newly detected nodes again.',
      slaveModelUnregistered: 'Node "{name}" uses {provider}/{model}, but that model is not advertised by the route; it will fail at spawn.',
      slaveDisabledHint: 'Slave tools are off. The node pool below is saved but unused until enabled.',
      slaveNodes: 'Slave nodes',
      slaveNodesOptional: 'optional manual override',
      slaveNodesHint: 'Optional manual override. Each node is an LLM route (provider/model); order is preserved and the default node overrides round-robin. Leave the list empty to use automatic discovery.',
      slaveNodeName: 'Name',
      slaveNodeNameHint: 'Unique name the agent uses to pick this node.',
      slaveNodeKind: 'Kind',
      slaveNodeLocal: 'local',
      slaveNodeCloud: 'cloud',
      slaveNodeProvider: 'Provider',
      slaveNodeProviderHint: 'LLM route provider, e.g. local-delegate, intranet-gemma, deepseek-account.',
      slaveNodeModel: 'Model',
      slaveNodeModelHint: 'Empty = the route/endpoint default model.',
      slaveNodeNote: 'Note',
      slaveNodeNoteHint: 'Optional.',
      slaveAddNode: 'Add node',
      slaveRemoveNode: 'Remove node',
      slaveFillLocal: 'Fill a local node from this endpoint',
      slaveDefaultNode: 'Default node',
      slaveRoundRobin: 'Round-robin',
      slaveMaxSlaves: 'Max slaves per spawn',
      slaveMaxSlavesHint: '1–8 (DSH default maxActiveSubagents is 8).',
      slavePreset: 'Slave agent preset',
      slaveFallback: 'Slave route failure',
      slaveFallbackInherit: 'Inherit the parent model (retry)',
      slaveFallbackFail: 'Fail with an actionable error',
      slavePromptHelp: 'Inject SlaveAgentTeams guidance into the system prompt',
      slaveProvider: 'Subagent provider',
      slaveProviderHint: 'Subagent provider used to start slaves (default spawn).',
      slaveMaxDepth: 'Slave max depth',
      slaveMaxDepthHint: '1–5; slaves cannot spawn further slaves by default.',
      slaveImplicitNode: 'No nodes configured: an implicit local node {node} is used. Set the endpoint model above.',
      slaveRouteMissing: 'A local node uses provider “local-delegate”, but that route is not registered in llm-pi-ai. Click “Enable for Subagent” above first.',
      slaveProviderUnregistered: 'Node “{name}” uses provider “{provider}”, which is not registered in llm-pi-ai. Register the route under Models first.',
      slaveCompatNote:
        'Coexists with native Agent Teams: no shared tool names, no global settings changed. Teammates keep the strong model; slaves are child agents, so they do not appear in the team roster and are not waited on by wait_agent.',
      slaveToolsNote: 'Tools: slave_team_spawn · slave_team_status · slave_team_wait · slave_team_send · slave_team_interrupt',
      slaveNameRequired: 'Every slave node needs a name.',
      slaveNameDuplicate: 'Slave node names must be unique.',
      slaveMaxRange: 'Max slaves must be between 1 and 8.',
      slaveDepthRange: 'Depth must be between 1 and 5.',
      slaveAdvanced: 'Advanced slave settings',
      slaveNodeLimit: 'Only the first 12 nodes are used; extra nodes are ignored.',
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
      endpointNumberInvalid: '{field} 必须是 {min} 到 {max} 之间的数字。',
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
      limits: '高级限制（一般不用改）',
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
      healthFallback: '备用端点',
      healthOnline: '在线',
      healthOffline: '离线',
      healthModelMissing: '可达但模型缺失',
      healthEndpoints: '端点链状态',
      healthNoFallbacks: '未配置备用端点。',
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
      statsWorkers: 'local_worker 启动数',
      statsWorkersFailed: 'worker 失败数',
      statsSlaves: 'slave 启动数',
      statsSlavesSettled: 'slave 完成数',
      statsSlavesFailed: 'slave 失败数',
      statsByNode: '按节点统计的 slave 启动数',
      subagent: '作为 Subagent / 模型选择器路由',
      subagentHint:
        '这是一个操作按钮，不是即时开关：点击后会把当前端点注册进 DSH 模型目录（通过 llm-pi-ai，provider 名为 local-delegate），并加入 Subagent 的可选模型。Subagent 策略在新建会话时采样，启用后请新开会话使用。操作结果会直接显示在按钮下方。',
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
      levels: '本地 AI 介入程度',
      levelsHint:
        '按项目工作区生效，新会话开始时采样。默认 = 当前行为；更高 = 机械块优先交给本地模型并开放 local_worker；最高 = 主 agent 只做规划，所有修改/命令交给本地 worker。Agent Teams 的 teammate 仍使用强模型。需要立即作用于运行中的会话时，打开“立即应用到活动 agent”。',
      levelsEnabled: '启用等级策略',
      levelsEnabledHint: '关闭后所有工作区都按“默认”处理（等同 v0.3 行为），与下面的选择无关。',
      levelsDefault: '默认等级',
      levelsDefaultHint: '没有单独设置的工作区、以及无法匹配工作区的会话使用该等级。',
      levelNone: '无（禁用本地模型）',
      levelLight: '轻度（只委派长文档/批量）',
      levelDefault: '默认（当前行为）',
      levelHigh: '更高（优先本地）',
      levelMax: '最高（只规划）',
      levelsInherit: '跟随默认',
      levelsWorkspaces: '工作区列表',
      levelsWorkspacesHint: '按工作区单独覆盖。路径由 Host 的规范化工作区注册表提供；比较时忽略大小写与斜杠方向。',
      levelsNoWorkspaces: '未找到工作区（workspaceRegistry 未挂载，或当前没有打开的工作区）。',
      levelsNoWorkspacesHint: '在 DSH 中打开一个工作区后点“刷新工作区列表”。',
      levelsUnavailable: 'Host 尚未提供 /levels 接口（插件版本过旧，或工作区注册表不可用）。',
      levelsRefresh: '刷新工作区列表',
      levelsLoadFailed: '工作区列表加载失败：{error}',
      levelsAdvanced: '等级高级设置',
      levelsNeedsRoute: '“更高/最高”需要 llm-pi-ai 里存在 local-delegate 路由。请先点上面的“启用为 Subagent 模型”，再新开会话。',
      levelsTeamNote: 'Agent Teams 的 teammate 当前仍用强模型（DSH 的 Team spawn 不带模型参数），只有本地 worker 才是本地的。',
      levelsDisabledNote: '等级策略已关闭：所有工作区都按“默认”处理（v0.3 行为）。',
      composerLevel: '在输入框显示等级选择器',
      composerLevelHint: '在输入框工具栏（模型 / 推理等级控件旁）显示紧凑的「本地 AI 介入程度」选择器：修改当前工作区的覆盖等级；会话未归属工作区时修改全局默认等级。',
      composerLevelShort: '本地 AI',
      composerLevelTitle: '本地 AI 介入程度（当前工作区）',
      composerLevelMenuTitle: '本地 AI 介入程度',
      composerLevelWorkspace: '工作区',
      composerLevelDefaultMode: '当前会话未归属工作区 —— 这里修改的是全局默认等级。',
      composerLevelInherit: '跟随默认',
      composerLevelNewSession: '对新会话生效。',
      composerLevelConflict: '配置已被其他编辑器改动，请重试。',
      composerLevelSaveFailed: '保存失败：{error}',
      levelsInvalid: '默认等级必须是 none/light/default/high/max 之一。',
      levelsInvalidWorkspace: '以下工作区的等级不合法：',
      levelsThresholdInvalid: '阈值必须是正整数。',
      workerProvider: 'worker 子 agent provider',
      workerProviderHint: '启动 local_worker 子 agent 使用的 Subagent provider（默认 spawn）。',
      workerPreset: 'worker agent preset',
      workerPresetHint: 'local_worker 子 agent 使用的 preset（默认 standard）。',
      workerRouteProvider: 'worker LLM 路由 provider',
      workerRouteProviderHint: '本地 worker 使用的 LLM 路由（由“启用为 Subagent 模型”创建，默认 local-delegate）。',
      workerRouteModel: 'worker 路由模型',
      workerRouteModelHint: '留空 = 使用上面的端点模型。',
      workerMaxDepth: 'worker 最大深度',
      workerMaxDepthHint: '1–5；worker 子 agent 还能再派生的层数。',
      lightMinChars: '轻度最小字符数',
      lightMinCharsHint: '“轻度”等级下，文件至少这么大才允许委派。',
      lightMinFiles: '轻度最小文件数',
      lightMinFilesHint: '“轻度”等级下，批量任务至少包含这么多文件才允许委派。',
      highMinChars: '更高最小字符数',
      highMinCharsHint: '“更高”等级下，内联文本达到该长度才允许委派。',
      plannerAllowRead: '最高等级允许 planner 读文件',
      plannerAllowReadHint: '保留 read/glob/grep 供规划使用；关闭后隔离最严格。',
      plannerFallback: 'planner worker 失败时',
      plannerFallbackStrong: '改用强模型重试（成本上升，保证完成）',
      plannerFallbackFail: '直接失败并返回错误',
      plannerDenyExtra: '额外禁用的工具（逗号分隔）',
      plannerAllowExtra: '额外允许的工具（逗号分隔）',
      plannerListHint: '逗号分隔的工具名，例如 bash, write。',
      applyToLiveAgents: '立即应用到活动 agent',
      applyToLiveAgentsHint: '设置变化时对运行中的 agent 重装 scoped 提示词/工具（可能损失部分 prompt 缓存）。',
      slaveTeams: 'SlaveAgentTeams（多从节点并行）',
      slaveTeamsHint:
        '打开后，root/Team Lead agent 会获得节点池与 5 个 slave_team_* 工具：一次并行启动多个 slave 子 agent，每个跑在本地廉价模型或云端路由上，再由 master 等待/汇总结果。与原生 Agent Teams 兼容：teammate 仍用强模型，slave 不会出现在 team 名单里。',
      slaveTeamsShortHint: '把独立任务交给本地/云端 slave 子 agent 并行执行；slave 是子 agent，不是 Team teammate。',
      slaveTeamsEnable: '启用 SlaveAgentTeams 工具',
      slaveTeamsEnableHint: '只有 root agent（及 Team Lead）会拿到 slave_team_* 工具；child agent 与 teammate 永远不装。',
      slaveAutoDiscover: '自动检测并启用所有可用端点与备用端点（推荐）',
      slaveAutoDiscoverHint:
        '只需这一个开关：root agent 在 spawn 时自动发现所有已挂载的 LLM 路由/模型，轮询优先本地路由；单个节点启动失败自动换下一个。云端路由默认只作为故障转移候选（显式指定节点时才直接使用）。保存时还会把端点链（主端点 + 备用端点）自动注册成 llm-pi-ai 路由。',
      slaveAutoMode: '自动模式',
      slaveAutoNodes: '检测到的节点',
      slaveAutoEmpty: '暂未检测到 LLM 路由。先保存一次，让端点链注册成路由，再刷新检测。',
      slaveAutoRefresh: '刷新检测',
      slaveAutoDetected: '检测到 {count} 条路由、{nodes} 个可用节点（spawn 池）。',
      slaveAutoIssues: '检测说明：{issues}',
      slaveAutoRoutesSync: '已在 llm-pi-ai 中注册 {count} 条端点链路由。',
      slaveAutoRoutesFailed: '端点链路由自动注册失败：{error}',
      slaveAutoSyncNow: '立即注册端点链路由',
      slaveAutoOffHint: '自动检测已关闭；将按下面配置的节点池使用。',
      slaveAvailable: '可用节点',
      slaveAvailableHint:
        '勾选要加入 SlaveAgentTeams 的节点。默认只显示端点链路由，其他已挂载路由会在下方提示。未勾选任何节点时，自动模式会使用全部检测到的节点。当前工作区等级为 none 时，本地节点不会参与 spawn。',
      slaveAvailableSelected: '已选 {selected}/{total}',
      slaveAvailableRouteHint:
        '列表按 LLM 路由/模型对计数，不是按端点计数：一个端点可以暴露多个模型，同一个模型也可能通过不同 provider 再次出现。',
      slaveOtherRoutesHint:
        '另有 {count} 条其他已挂载路由（{providers}）不属于端点链，已从列表中隐藏；需要时请用高级节点编辑器添加。',
      slaveCleanNodes: '清理无效/重复节点',
      slaveAvailableEmpty: '暂未检测到可用节点。先保存端点链、注册路由，再刷新检测。',
      slaveSelectAll: '全选可用节点',
      slaveManualSelection: '当前是手动选中的节点。点击“全选可用节点”可重新纳入新检测到的节点。',
      slaveModelUnregistered: '节点“{name}”使用 {provider}/{model}，但该路由未声明这个模型；spawn 时会失败。',
      slaveDisabledHint: 'Slave 工具当前关闭。下面的节点池会保存，但启用前不会生效。',
      slaveNodes: '从节点列表',
      slaveNodesOptional: '可选的手动覆盖',
      slaveNodesHint: '可选的手动覆盖。每个节点是一条 LLM 路由（provider/model），顺序即配置顺序；设置了默认节点时优先用默认节点，否则轮询。留空则使用自动检测。',
      slaveNodeName: '名称',
      slaveNodeNameHint: 'agent 选择节点时使用的唯一名称。',
      slaveNodeKind: '类型',
      slaveNodeLocal: '本地',
      slaveNodeCloud: '云端',
      slaveNodeProvider: 'Provider',
      slaveNodeProviderHint: 'LLM 路由 provider，例如 local-delegate、intranet-gemma、deepseek-account。',
      slaveNodeModel: '模型',
      slaveNodeModelHint: '留空 = 使用该路由/端点的默认模型。',
      slaveNodeNote: '备注',
      slaveNodeNoteHint: '可选。',
      slaveAddNode: '添加节点',
      slaveRemoveNode: '删除节点',
      slaveFillLocal: '用本地端点填充一个本地节点',
      slaveDefaultNode: '默认节点',
      slaveRoundRobin: '轮询',
      slaveMaxSlaves: '单次最多 slave 数',
      slaveMaxSlavesHint: '1–8（DSH 默认 maxActiveSubagents = 8）。',
      slavePreset: 'slave agent preset',
      slaveFallback: 'slave 路由失败时',
      slaveFallbackInherit: '继承父模型重试',
      slaveFallbackFail: '直接报可操作错误',
      slavePromptHelp: '向系统提示词注入 SlaveAgentTeams 指引',
      slaveProvider: 'Subagent provider',
      slaveProviderHint: '启动 slave 使用的 Subagent provider（默认 spawn）。',
      slaveMaxDepth: 'slave 最大深度',
      slaveMaxDepthHint: '1–5；默认 slave 不能再派生 slave。',
      slaveImplicitNode: '未配置节点：将使用隐式本地节点 {node}。请先在上面设置端点模型。',
      slaveRouteMissing: '有本地节点使用 provider “local-delegate”，但该路由尚未注册到 llm-pi-ai。请先点上面的“启用为 Subagent 模型”。',
      slaveProviderUnregistered: '节点“{name}”使用的 provider “{provider}”尚未在 llm-pi-ai 注册，请先在 Models 页注册该路由。',
      slaveCompatNote:
        '与原生 Agent Teams 共存：不注册同名工具、不修改任何全局设置。teammate 继续用强模型；slave 是子 agent，不会出现在 team 名单，也不会被 wait_agent 等待。',
      slaveToolsNote: '工具：slave_team_spawn · slave_team_status · slave_team_wait · slave_team_send · slave_team_interrupt',
      slaveNameRequired: '每个从节点都必须填写名称。',
      slaveNameDuplicate: '从节点名称必须唯一。',
      slaveMaxRange: '单次最多 slave 数必须在 1–8 之间。',
      slaveDepthRange: '深度必须在 1–5 之间。',
      slaveAdvanced: 'slave 高级设置',
      slaveNodeLimit: '最多只使用前 12 个节点，多余的会被忽略。',
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
.ld_endpoints{display:flex;flex-direction:column;gap:6px}
.ld_endpoint{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.ld_endpoint .ld_small{flex:1 1 180px;min-width:0;overflow-wrap:anywhere}
.ld_available{display:flex;flex-direction:column;gap:6px}
.ld_auto{display:flex;flex-direction:column;gap:8px}
.ld_available_row{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px}
.ld_available_row input{margin-top:2px}
.ld_available_row .ld_small{flex:1;min-width:0;overflow-wrap:anywhere}
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
.ld_levelrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.ld_levelrow .ld_grow{flex:1 1 320px;min-width:220px}
.ld_levelrow select{max-width:220px;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px}
.ld_name{font-weight:500}
.ld_nodes{display:flex;flex-direction:column;gap:10px}
.ld_node{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.ld_node .ld_row{gap:10px}
.ld_node_head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ld_node_head .ld_small{flex:1;min-width:160px}
.ld_chips{display:flex;flex-wrap:wrap;gap:6px}
.ld_chip{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ld_savebar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding-top:4px}
.ld_savebar .grow{flex:1}
.ld_composer{position:relative;display:inline-flex;align-items:center;gap:4px;min-width:0}
.ld_composer_trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(240px,38cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font:inherit;font-size:13px;font-weight:400;line-height:20px;display:flex}
.ld_composer_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ld_composer_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.ld_composer_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.ld_composer_label{white-space:nowrap;flex:none}
.ld_composer_value{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-caption);flex-shrink:1000;overflow:hidden}
.ld_composer_chevron{color:var(--dsw-alias-label-caption);flex:none;font-size:10px}
.ld_composer_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1}
.ld_composer_menu{z-index:1100;width:max-content;min-width:min(240px,100vw - 32px);max-width:min(380px,100vw - 32px);max-height:min(360px,100vh - 96px);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);flex-direction:column;gap:2px;padding:4px;display:flex;position:fixed;overflow:hidden}
.ld_composer_head{padding:6px 8px 4px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ld_composer_note{padding:2px 8px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ld_composer_item{box-sizing:border-box;width:auto;min-width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:var(--dsw-radius-md);outline:none;align-items:center;gap:6px;padding:5px 8px;font:inherit;font-size:13px;line-height:20px;display:flex}
.ld_composer_item:hover:not(:disabled),.ld_composer_item:focus-visible,.ld_composer_item.on{background:var(--dsw-alias-interactive-bg-hover)}
.ld_composer_check{color:var(--dsw-alias-label-primary);flex:0 0 14px;place-items:center;display:grid;font-size:12px}
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

    /* ── 0.4.0 pure helpers (also exported through __test) ───────────────── */

    function parseLevel(value) {
      const level = String(value || '')
      return LEVEL_VALUES.includes(level) ? level : 'default'
    }

    function listToText(value) {
      return Array.isArray(value) ? value.filter(entry => typeof entry === 'string' && entry.trim()).join(', ') : ''
    }

    function textToList(text) {
      return String(text === undefined || text === null ? '' : text)
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
    }

    function normalizePathKey(value) {
      return String(value || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
    }

    function findWorkspaceLevel(workspaceLevels, workspacePath) {
      if (!workspaceLevels || typeof workspaceLevels !== 'object') return ''
      const target = normalizePathKey(workspacePath)
      if (!target) return ''
      for (const [key, value] of Object.entries(workspaceLevels)) {
        if (normalizePathKey(key) === target) return parseLevel(value)
      }
      return ''
    }

    function withWorkspaceLevel(workspaceLevels, workspacePath, level) {
      const next = { ...(workspaceLevels && typeof workspaceLevels === 'object' ? workspaceLevels : {}) }
      const target = normalizePathKey(workspacePath)
      for (const key of Object.keys(next)) {
        if (normalizePathKey(key) === target) delete next[key]
      }
      const value = String(level || '')
      if (LEVEL_VALUES.includes(value) && String(workspacePath || '').trim()) next[String(workspacePath)] = value
      return next
    }

    /* ── composer level picker helpers (0.4.1) ──────────────────────────── */

    /** Find the WorkspaceView whose sessionIds account includes one session. */
    function resolveComposerWorkspace(workspaces, sessionId) {
      const list = Array.isArray(workspaces) ? workspaces : []
      const id = String(sessionId || '')
      if (!id) return null
      for (const workspace of list) {
        if (!workspace || typeof workspace !== 'object') continue
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        if (sessionIds.includes(id)) return workspace
      }
      return null
    }

    /**
     * Pure view model for the composer picker. Returns null when the feature or
     * the level policy is off, so the component renders nothing.
     */
    function composerLevelModel(config, workspace, t) {
      const source = config && typeof config === 'object' ? config : {}
      if (source.levelsEnabled === false || source.composerLevelPicker === false) return null
      const defaultLevel = parseLevel(source.defaultLevel)
      const workspacePath = workspace && typeof workspace.path === 'string' ? workspace.path : ''
      const override = workspacePath ? findWorkspaceLevel(source.workspaceLevels, workspacePath) : ''
      const value = override || defaultLevel
      const inheritOption = workspacePath
        ? { value: '', label: t('composerLevelInherit') + ' · ' + levelOptionLabel(t, defaultLevel) }
        : null
      const options = (inheritOption ? [inheritOption] : []).concat(levelSelectOptions(t))
      return {
        mode: workspacePath ? 'workspace' : 'default',
        workspacePath,
        workspaceLabel: workspace ? String(workspace.title || workspacePath || '') : '',
        defaultLevel,
        override,
        value,
        options,
      }
    }

    function buildSlaveNode(overrides) {
      return { name: '', kind: 'local', provider: ROUTE_PROVIDER, model: '', note: '', ...(overrides || {}) }
    }

    function uniqueSlaveName(nodes, base) {
      const used = new Set(
        (Array.isArray(nodes) ? nodes : [])
          .map(node => String((node && node.name) || '').trim())
          .filter(Boolean),
      )
      if (!used.has(base)) return base
      for (let index = 2; index < 100; index += 1) {
        if (!used.has(base + index)) return base + index
      }
      return base + 'x'
    }

    /** Turn llm-pi-ai `providers` into a stable catalog for the datalists. */
    function providerCatalog(providers) {
      if (!providers || typeof providers !== 'object') return []
      const catalog = []
      for (const [rawId, value] of Object.entries(providers)) {
        const id = String(rawId || '').trim()
        if (!id) continue
        const models = Array.isArray(value && value.models)
          ? value.models
              .map(model => (typeof model === 'string' ? model : model && (model.id || model.model)) || '')
              .map(String)
              .filter(Boolean)
          : []
        catalog.push({ id, models })
      }
      catalog.sort((a, b) => a.id.localeCompare(b.id))
      return catalog
    }

    function nodesOf(config) {
      return Array.isArray(config && config.slaveNodes)
        ? config.slaveNodes.filter(node => node && typeof node === 'object')
        : []
    }

    function usesHighOrMax(config, workspaces) {
      if (config && config.levelsEnabled === false) return false
      if (parseLevel(config && config.defaultLevel) === 'high' || parseLevel(config && config.defaultLevel) === 'max') return true
      return (Array.isArray(workspaces) ? workspaces : []).some(workspace => {
        const value = findWorkspaceLevel(config && config.workspaceLevels, workspace && workspace.path) || parseLevel(workspace && workspace.level)
        return value === 'high' || value === 'max'
      })
    }

    function levelOptionLabel(t, level) {
      return level === 'none'
        ? t('levelNone')
        : level === 'light'
          ? t('levelLight')
          : level === 'default'
            ? t('levelDefault')
            : level === 'high'
              ? t('levelHigh')
              : t('levelMax')
    }

    function levelSelectOptions(t) {
      return LEVEL_VALUES.map(level => ({ value: level, label: levelOptionLabel(t, level) }))
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

    /** Reject endpoint numbers that would silently break every model request. */
    function validateEndpointNumbers(endpoint, t) {
      const source = endpoint && typeof endpoint === 'object' ? endpoint : {}
      for (const [field, min, max] of [
        ['timeoutMs', 1000, 3600000],
        ['maxOutputTokens', 1, 1000000],
        ['numCtx', 512, 1048576],
      ]) {
        if (source[field] === undefined) continue
        const value = Number(source[field])
        if (!Number.isFinite(value) || value < min || value > max) {
          return { kind: 'err', text: format(t('endpointNumberInvalid'), { field, min, max }) }
        }
      }
      if (source.temperature !== undefined) {
        const value = Number(source.temperature)
        if (!Number.isFinite(value) || value < 0 || value > 2) {
          return { kind: 'err', text: format(t('endpointNumberInvalid'), { field: 'temperature', min: 0, max: 2 }) }
        }
      }
      return null
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

    function TextInput({ value, onChange, disabled, placeholder, type, list }) {
      return h('input', {
        type: type || 'text',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: placeholder || '',
        list: list || undefined,
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
      const [subagentNotice, setSubagentNotice] = useState(null)
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState('')
      const [probe, setProbe] = useState(null)
      const [models, setModels] = useState([])
      const [levelsInfo, setLevelsInfo] = useState(null)
      const [levelsError, setLevelsError] = useState('')
      const [slaveInfo, setSlaveInfo] = useState(null)
      const [slaveError, setSlaveError] = useState('')
      const [listText, setListText] = useState(null)

      useEffect(() => {
        dirtyRef.current = dirty
      }, [dirty])

      useEffect(() => {
        if (snap.status !== 'ready') return
        if (dirtyRef.current) return
        setDraft(clone(snap.value))
        setListText(null)
      }, [snap.status, snap.revision])

      const saved = snap.status === 'ready' ? snap.value : null
      const writable = snapshotWritable(snap)
      const disabled = !writable || !draft
      const current = draft || saved || {}

      const refreshStatus = useCallback(async (probe = false) => {
        try {
          const payload = await apiFetch('/status' + (probe ? '?probe=1' : ''))
          setStatus(payload)
          setStatusError('')
          return payload
        } catch (error) {
          setStatusError(String(error?.message ?? error))
          return null
        }
      }, [])

      const refreshLevels = useCallback(async () => {
        try {
          const payload = await apiFetch('/levels')
          setLevelsInfo(payload)
          setLevelsError('')
        } catch (error) {
          setLevelsError(String(error?.message ?? error))
        }
      }, [])

      const refreshSlaves = useCallback(async () => {
        try {
          const payload = await apiFetch('/slaves')
          setSlaveInfo(payload)
          setSlaveError('')
        } catch (error) {
          setSlaveInfo(null)
          setSlaveError(String(error?.message ?? error))
        }
      }, [])

      useEffect(() => {
        void refreshStatus()
        void refreshLevels()
        void refreshSlaves()
      }, [refreshLevels, refreshSlaves, refreshStatus])

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

      /* ── 0.4.0 draft editors ───────────────────────────────────────────── */

      const listValue = useCallback(
        field => (listText && Object.prototype.hasOwnProperty.call(listText, field) ? listText[field] : listToText(current[field])),
        [current, listText],
      )

      const setListField = useCallback(
        (field, text) => {
          setListText(prev => ({ ...(prev || {}), [field]: text }))
          update([field], textToList(text))
        },
        [update],
      )

      const setWorkspaceLevel = useCallback((workspacePath, level) => {
        setDraft(prev => ({ ...(prev || {}), workspaceLevels: withWorkspaceLevel(prev && prev.workspaceLevels, workspacePath, level) }))
        setDirty(true)
        setMessage(null)
      }, [])

      const setNode = useCallback((index, key, value) => {
        setDraft(prev => {
          const base = prev || {}
          const nodes = Array.isArray(base.slaveNodes) ? base.slaveNodes.slice() : []
          nodes[index] = { ...(nodes[index] || {}), [key]: value }
          return { ...base, slaveNodes: nodes }
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const addNode = useCallback(() => {
        setDraft(prev => {
          const base = prev || {}
          const nodes = Array.isArray(base.slaveNodes) ? base.slaveNodes.slice() : []
          nodes.push(buildSlaveNode({ name: uniqueSlaveName(nodes, 'local') }))
          return { ...base, slaveNodes: nodes }
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const removeNode = useCallback(index => {
        setDraft(prev => {
          const base = prev || {}
          const nodes = Array.isArray(base.slaveNodes) ? base.slaveNodes.slice() : []
          nodes.splice(index, 1)
          return { ...base, slaveNodes: nodes }
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const fillLocalNode = useCallback(() => {
        setDraft(prev => {
          const base = prev || {}
          const nodes = Array.isArray(base.slaveNodes) ? base.slaveNodes.slice() : []
          const model = String((saved && saved.endpoint && saved.endpoint.model) || (base.endpoint && base.endpoint.model) || '').trim()
          const node = buildSlaveNode({ name: 'local', kind: 'local', provider: ROUTE_PROVIDER, model })
          const existing = nodes.findIndex(entry => entry && String(entry.name || '').trim() === 'local')
          if (existing >= 0) nodes[existing] = node
          else nodes.push(node)
          return { ...base, slaveNodes: nodes }
        })
        setDirty(true)
        setMessage(null)
      }, [saved])

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
        // An empty NumberInput becomes 0. Reject values that would make every
        // request fail (timeoutMs 0 aborts after 1ms, maxOutputTokens 0 asks for
        // zero output tokens) instead of silently saving a broken endpoint.
        const endpointIssue = validateEndpointNumbers(endpoint, t)
        if (endpointIssue) return endpointIssue
        if (!LEVEL_VALUES.includes(String(current.defaultLevel || 'default'))) {
          return { kind: 'err', text: t('levelsInvalid') }
        }
        if (current.workspaceLevels && typeof current.workspaceLevels === 'object' && !Array.isArray(current.workspaceLevels)) {
          for (const [key, value] of Object.entries(current.workspaceLevels)) {
            if (!LEVEL_VALUES.includes(String(value))) return { kind: 'err', text: t('levelsInvalidWorkspace') + key }
          }
        }
        for (const field of ['lightMinChars', 'lightMinFiles', 'highMinChars']) {
          if (current[field] === undefined) continue
          const value = Number(current[field])
          if (!Number.isFinite(value) || value <= 0 || Math.floor(value) !== value) return { kind: 'err', text: t('levelsThresholdInvalid') }
        }
        for (const field of ['workerMaxDepth', 'slaveTeamMaxDepth']) {
          if (current[field] === undefined) continue
          const value = Number(current[field])
          if (!Number.isFinite(value) || value < 1 || value > 5) return { kind: 'err', text: t('slaveDepthRange') }
        }
        if (current.slaveTeamMaxSlaves !== undefined) {
          const value = Number(current.slaveTeamMaxSlaves)
          if (!Number.isFinite(value) || value < 1 || value > MAX_SLAVES) return { kind: 'err', text: t('slaveMaxRange') }
        }
        const nodeNames = new Set()
        for (const node of nodesOf(current)) {
          const name = String(node.name || '').trim()
          if (!name) return { kind: 'err', text: t('slaveNameRequired') }
          const key = name.toLowerCase()
          if (nodeNames.has(key)) return { kind: 'err', text: t('slaveNameDuplicate') + ' (' + name + ')' }
          nodeNames.add(key)
        }
        return null
      }, [current, endpoint, fallbacks, t])

      /**
       * Register the endpoint chain (primary + fallbacks) as llm-pi-ai routes so
       * every configured endpoint becomes usable by slave child agents. One
       * route per distinct host/credentials group; models share the route.
       */
      const syncEndpointRoutes = useCallback(
        async (configValue, health) => {
          if (piSnap.status !== 'ready') {
            return { ok: false, written: 0, error: 'llm-pi-ai settings are unavailable' }
          }
          const groups = groupChainEndpoints(configValue, health)
          if (groups.length === 0) return { ok: true, written: 0 }
          const existingProviders = piSnap.value && piSnap.value.providers ? piSnap.value.providers : {}
          const ops = buildChainRouteOps(configValue, health, existingProviders)
          try {
            // Route sync is idempotent and only touches this plugin's own
            // provider ids, so do not fence it with a possibly stale revision
            // right after another llm-pi-ai edit (Enable/Remove route).
            const accepted = await piForm.mutate(ops)
            return accepted
              ? { ok: true, written: ops.length }
              : { ok: false, written: 0, error: 'llm-pi-ai rejected the route update' }
          } catch (error) {
            return { ok: false, written: 0, error: String(error?.message ?? error) }
          }
        },
        [piForm, piSnap.status],
      )

      const syncRoutesNow = useCallback(async () => {
        setBusy('slaveRoutes')
        setMessage(null)
        try {
          const fresh = await refreshStatus(true)
          const outcome = await syncEndpointRoutes(draft || saved, fresh && fresh.health)
          if (outcome.ok && outcome.written > 0) {
            setMessage({ kind: 'ok', text: format(t('slaveAutoRoutesSync'), { count: outcome.written }) })
          } else if (!outcome.ok) {
            setMessage({ kind: 'warn', text: format(t('slaveAutoRoutesFailed'), { error: outcome.error }) })
          } else {
            setMessage({ kind: 'warn', text: t('slaveAutoEmpty') })
          }
          await refreshSlaves()
        } finally {
          setBusy('')
        }
      }, [draft, refreshSlaves, refreshStatus, saved, syncEndpointRoutes, t])

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
          let sync = null
          if (draft.slaveTeamsEnabled === true) {
            // Register the configured chain without the previous health filter:
            // the just-saved primary/fallback models must both appear in the
            // available-node picker. The explicit "sync now" action can still
            // skip models the latest probe reports missing.
            sync = await syncEndpointRoutes(draft, null)
          }
          if (sync && sync.written > 0) {
            setMessage({
              kind: sync.ok ? 'ok' : 'warn',
              text:
                t('saved') +
                ' ' +
                (sync.ok
                  ? format(t('slaveAutoRoutesSync'), { count: sync.written })
                  : format(t('slaveAutoRoutesFailed'), { error: sync.error })),
            })
          } else {
            setMessage({ kind: 'ok', text: t('saved') })
          }
          void refreshStatus(true)
          void refreshLevels()
          void refreshSlaves()
        } catch (error) {
          setMessage({ kind: 'err', text: t('saveFailed') + ' ' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [draft, form, refreshLevels, refreshSlaves, refreshStatus, saved, snap.revision, status, syncEndpointRoutes, t, validate])

      const discard = useCallback(() => {
        if (!saved) return
        setDraft(clone(saved))
        setListText(null)
        setDirty(false)
        setMessage(null)
      }, [saved])

      const resetAll = useCallback(() => {
        if (!snap.base) return
        setDraft(clone(snap.base))
        setListText(null)
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
      const piProviders = piReady ? providerCatalog(piSnap.value && piSnap.value.providers) : []
      const subAllowed = Boolean(
        subReady &&
          subSnap.value &&
          subSnap.value.enabled === true &&
          Array.isArray(subSnap.value.allowedModels) &&
          subSnap.value.allowedModels.some(route => route && route.provider === ROUTE_PROVIDER),
      )

      const enableSubagentRoute = useCallback(async () => {
        if (!saved || dirty) {
          setSubagentNotice({ kind: 'warn', text: t('subagentNeedsSave') })
          return
        }
        const model = String(saved.endpoint.model || '').trim()
        if (!model) {
          setSubagentNotice({ kind: 'warn', text: t('subagentNeedsModel') })
          return
        }
        if (!piReady || !subReady) {
          setSubagentNotice({ kind: 'warn', text: t('subagentUnavailable') })
          return
        }
        setBusy('subagent')
        setSubagentNotice(null)
        try {
          const existingProvider = piReady && piSnap.value && piSnap.value.providers ? piSnap.value.providers[ROUTE_PROVIDER] : undefined
          const provider = buildPiProvider(saved.endpoint, undefined, undefined, existingProvider)
          const piOk = await piForm.mutate([{ op: 'set', path: ['providers', ROUTE_PROVIDER], value: provider }], piSnap.revision)
          if (!piOk) {
            setSubagentNotice({ kind: 'err', text: t('subagentFailed') })
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
          setSubagentNotice({ kind: subOk ? 'ok' : 'err', text: subOk ? t('subagentDone') : t('subagentFailed') })
          void refreshStatus()
        } catch (error) {
          setSubagentNotice({ kind: 'err', text: t('subagentFailed') + ' ' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [dirty, piForm, piReady, piSnap, refreshStatus, saved, subForm, subReady, subSnap, t])

      const disableSubagentRoute = useCallback(async () => {
        if (!piReady || !subReady) return
        setBusy('subagent')
        setSubagentNotice(null)
        try {
          const providers = piSnap.value && piSnap.value.providers ? piSnap.value.providers : {}
          const ops = buildChainUnrouteOps(providers)
          // No expected revision for owned-route removal: the route sync may
          // have just bumped the mirror. Never report success on a rejected
          // mutation (the old code silently claimed "removed").
          const piOk = ops.length === 0 ? true : await piForm.mutate(ops)
          if (!piOk) {
            setSubagentNotice({ kind: 'err', text: t('subagentFailed') })
            return
          }
          const currentRoutes = Array.isArray(subSnap.value.allowedModels) ? subSnap.value.allowedModels : []
          const routes = currentRoutes.filter(route => route && route.provider !== ROUTE_PROVIDER)
          const subOk = await subForm.mutate(
            [
              { op: 'set', path: ['allowedModels'], value: routes },
              { op: 'set', path: ['enabled'], value: routes.length > 0 },
            ],
            subSnap.revision,
          )
          if (!subOk) {
            setSubagentNotice({ kind: 'err', text: t('subagentFailed') })
            return
          }
          setSubagentNotice({ kind: 'ok', text: t('subagentRemoved') })
          void refreshStatus()
        } catch (error) {
          setSubagentNotice({ kind: 'err', text: t('subagentFailed') + ' ' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [piForm, piReady, piSnap, refreshStatus, subForm, subReady, subSnap, t])

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

        h(HealthCard, { t, health, status, onRefresh: () => refreshStatus(true), busy }),

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
              h(Field, { label: t('timeoutMs') }, h(NumberInput, { value: endpoint.timeoutMs, disabled, min: 1000, onChange: value => setEndpoint('timeoutMs', value) })),
              h(
                Field,
                { label: t('apiKeyEnv'), hint: t('apiKeyEnvHint') },
                h(TextInput, { value: endpoint.apiKeyEnv, disabled, placeholder: 'LOCAL_MODEL_API_KEY', onChange: value => setEndpoint('apiKeyEnv', value) }),
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
          'details',
          { className: 'ld_fold' },
          h('summary', null, t('fallback') + ' · ' + String(fallbacks.length)),
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
          'details',
          { className: 'ld_fold' },
          h('summary', null, t('limits')),
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
          notice: subagentNotice,
          onEnable: enableSubagentRoute,
          onDisable: disableSubagentRoute,
          savedEndpoint: saved.endpoint,
        }),

        h(LevelsCard, {
          t,
          current,
          disabled,
          update,
          levelsInfo,
          levelsError,
          onRefreshLevels: refreshLevels,
          routeRegistered,
          endpointModel: String((saved.endpoint && saved.endpoint.model) || '').trim(),
          listValue,
          onListChange: setListField,
          onWorkspaceLevel: setWorkspaceLevel,
        }),

        h(SlaveTeamsCard, {
          t,
          current,
          disabled,
          update,
          piReady,
          providers: piProviders,
          routeRegistered,
          endpointModel: String((saved.endpoint && saved.endpoint.model) || '').trim(),
          autoInfo: slaveInfo,
          autoError: slaveError,
          autoDiscover: current.slaveTeamAutoDiscover !== false,
          autoBusy: busy === 'slaveRoutes',
          onRefreshAuto: refreshSlaves,
          onSyncRoutes: syncRoutesNow,
          onSetNode: setNode,
          onAddNode: addNode,
          onRemoveNode: removeNode,
          onFillLocalNode: fillLocalNode,
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
      const base = saved || {}
      const next = draft || {}
      const ops = []
      if (!deepEqual(base.endpoint, next.endpoint)) ops.push({ op: 'set', path: ['endpoint'], value: next.endpoint })
      if (!deepEqual(base.fallbackEndpoints, next.fallbackEndpoints)) ops.push({ op: 'set', path: ['fallbackEndpoints'], value: next.fallbackEndpoints })
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
        if (!deepEqual(base[field], next[field])) ops.push({ op: 'set', path: [field], value: next[field] })
      }
      if (!deepEqual(base.modelsByTask, next.modelsByTask)) ops.push({ op: 'set', path: ['modelsByTask'], value: next.modelsByTask })
      // 0.4.0 fields: stable order per the implementation contract (§9.3).
      for (const [field, whole] of V04_FIELDS) {
        const emptyValue = field === 'workspaceLevels' ? {} : []
        const before = base[field] === undefined ? emptyValue : base[field]
        const after = next[field] === undefined ? emptyValue : next[field]
        if (whole) {
          if (!deepEqual(before, after)) ops.push({ op: 'set', path: [field], value: clone(after) })
        } else if (next[field] !== undefined && !deepEqual(base[field], next[field])) {
          ops.push({ op: 'set', path: [field], value: next[field] })
        }
      }
      return ops
    }

    function normalizeChainBase(baseURL) {
      return String(baseURL || '').trim().replace(/\/+$/, '')
    }

    /**
     * Endpoint/model pairs the live health probe reports as missing. Registering
     * them as routes would create slave nodes that start and then fail on the
     * first model call, so the automatic route sync skips them until they exist.
     */
    function missingChainModels(health) {
      const missing = new Set()
      if (!health || typeof health !== 'object') return missing
      const entries = [health.primary, ...(Array.isArray(health.fallbacks) ? health.fallbacks : [])]
      for (const entry of entries) {
        if (!entry || entry.modelFound !== false) continue
        const base = normalizeChainBase(entry.baseURL)
        const model = String(entry.model || '').trim()
        if (base && model) missing.add(base + '|' + model)
      }
      return missing
    }

    /**
     * Group the endpoint chain by wire target so one llm-pi-ai provider can
     * carry every model that lives on the same host/credentials. This is what
     * makes the fallback endpoints usable as slave routes: pi-ai routes have a
     * single baseURL, so each distinct host needs its own route.
     * Models the latest health probe reports missing are skipped.
     */
    function groupChainEndpoints(config, health) {
      const source = config && typeof config === 'object' ? config : {}
      const missing = missingChainModels(health)
      const chain = [source.endpoint, ...(Array.isArray(source.fallbackEndpoints) ? source.fallbackEndpoints : [])]
      const groups = new Map()
      for (const endpoint of chain) {
        if (!endpoint || typeof endpoint !== 'object') continue
        const baseURL = normalizeChainBase(endpoint.baseURL)
        const model = String(endpoint.model || '').trim()
        if (!baseURL || !model) continue
        if (missing.has(baseURL + '|' + model)) continue
        const key = [
          endpoint.kind === 'openai-compatible' ? 'openai' : 'ollama',
          baseURL,
          JSON.stringify(endpoint.headers || {}),
          String(endpoint.apiKey || ''),
          String(endpoint.apiKeyEnv || ''),
        ].join('\u0000')
        if (!groups.has(key)) groups.set(key, { endpoint, models: [] })
        const group = groups.get(key)
        if (!group.models.includes(model)) group.models.push(model)
      }
      return [...groups.values()]
    }


    /** Display names this plugin generates; anything else is a user customization. */
    function isManagedDisplayName(value) {
      return /^本地\/降智模型（(?:SlaveAgentTeams 自动路由|dsh-local-delegate)）/.test(String(value || '').trim())
    }

    function modelIdOf(model) {
      return String(typeof model === 'string' ? model : model && (model.id || model.model) || '').trim()
    }

    /**
     * Build one llm-pi-ai provider. When the provider already exists, preserve
     * user-owned fields instead of overwriting them: a custom displayName, the
     * user's model order/extra model metadata, extra headers, and fields this
     * plugin does not manage. Wire fields (api/baseURL/defaults) still follow
     * the current endpoint so slave routes cannot drift.
     */
    function buildPiProvider(endpoint, models, displayName, existing) {
      const prior = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : null
      const raw = String(endpoint.baseURL || '').trim().replace(/\/+$/, '')
      const baseURL = /\/v\d+$/.test(raw) ? raw : raw + '/v1'
      const headers = { ...(endpoint.headers || {}) }
      const priorHeaders = prior && prior.headers && typeof prior.headers === 'object' ? prior.headers : {}
      if (endpoint.apiKey) headers.Authorization = 'Bearer ' + endpoint.apiKey
      else if (!headers.Authorization && !priorHeaders.Authorization && (!endpoint.kind || endpoint.kind === 'ollama-native')) {
        headers.Authorization = 'Bearer ollama'
      }
      const modelIds = (Array.isArray(models) ? models : [endpoint.model])
        .map(model => String(model || '').trim())
        .filter(Boolean)
      const generated = {
        displayName: displayName || '本地/降智模型（dsh-local-delegate）',
        api: 'openai-completions',
        baseURL,
        models: (modelIds.length > 0 ? modelIds : ['']).map(id => ({ id })),
        defaultContextWindow: Number(endpoint.numCtx) || 32768,
        defaultMaxTokens: Number(endpoint.maxOutputTokens) || 4096,
      }
      if (Object.keys(headers).length > 0) generated.headers = headers
      else if (endpoint.apiKeyEnv) generated.apiKeyEnv = endpoint.apiKeyEnv
      if (!prior) return generated

      const provider = { ...prior, ...generated }
      if (typeof prior.displayName === 'string' && prior.displayName.trim() && !isManagedDisplayName(prior.displayName)) {
        provider.displayName = prior.displayName
      }
      const mergedModels = new Map()
      for (const model of Array.isArray(prior.models) ? prior.models : []) {
        const id = modelIdOf(model)
        if (id) mergedModels.set(id, model)
      }
      for (const model of generated.models) {
        if (!mergedModels.has(model.id)) mergedModels.set(model.id, model)
      }
      provider.models = [...mergedModels.values()]
      const mergedHeaders = { ...priorHeaders, ...(generated.headers || {}) }
      if (Object.keys(mergedHeaders).length > 0) provider.headers = mergedHeaders
      return provider
    }

    /** Stable provider id per chain group: local-delegate, local-delegate-fb1… */
    function chainRouteProviderId(index) {
      return index === 0 ? ROUTE_PROVIDER : ROUTE_PROVIDER + '-fb' + String(index)
    }

    /** Provider ids this plugin owns: the primary route plus its fallback chain. */
    function chainRouteIds(providers) {
      return Object.keys(providers && typeof providers === 'object' ? providers : {}).filter(
        id => id === ROUTE_PROVIDER || id.startsWith(ROUTE_PROVIDER + '-fb'),
      )
    }

    /** llm-pi-ai unset ops for every route this plugin may have registered. */
    function buildChainUnrouteOps(providers) {
      return chainRouteIds(providers).map(id => ({ op: 'unset', path: ['providers', id] }))
    }

    /** llm-pi-ai config ops that register the whole endpoint chain as routes. */
    function buildChainRouteOps(config, health, existingProviders) {
      const providers = existingProviders && typeof existingProviders === 'object' ? existingProviders : {}
      return groupChainEndpoints(config, health).map((group, index) => ({
        op: 'set',
        path: ['providers', chainRouteProviderId(index)],
        value: buildPiProvider(
          group.endpoint,
          group.models,
          '本地/降智模型（SlaveAgentTeams 自动路由）' + (index > 0 ? ' #' + String(index + 1) : ''),
          providers[chainRouteProviderId(index)],
        ),
      }))
    }

    function HealthCard({ t, health, status, onRefresh, busy }) {
      const state = health ? health.status : 'unknown'
      const label = state === 'available' ? t('healthAvailable') : state === 'degraded' ? t('healthDegraded') : state === 'unavailable' ? t('healthUnavailable') : t('healthUnknown')
      const badge = state === 'available' ? 'ok' : state === 'degraded' ? 'warn' : state === 'unavailable' ? 'err' : ''
      const effective = health && health.effective ? health.effective : health && health.primary ? health.primary : null
      const savedConfig = status && status.config ? status.config : null
      const primary = health && health.primary ? health.primary : null
      const fallbacks = health && Array.isArray(health.fallbacks) ? health.fallbacks : []
      const endpointRows = []
      if (primary) endpointRows.push({ key: 'primary', label: t('healthPrimary'), entry: primary })
      for (const [index, entry] of fallbacks.entries()) {
        if (entry) endpointRows.push({ key: 'fallback-' + index, label: t('healthFallback') + ' ' + String(index + 1), entry })
      }
      const statusOf = entry => {
        if (!entry || entry.reachable !== true) {
          return { label: entry && entry.reachable === false ? t('healthOffline') : t('healthUnknown'), badge: entry && entry.reachable === false ? 'err' : '' }
        }
        if (entry.modelFound !== true) return { label: t('healthModelMissing'), badge: 'warn' }
        return { label: t('healthOnline'), badge: 'ok' }
      }
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
        endpointRows.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'ld_small' }, t('healthEndpoints')),
              h(
                'div',
                { className: 'ld_endpoints', style: { marginTop: '6px' } },
                endpointRows.map(row => {
                  const view = statusOf(row.entry)
                  return h(
                    'div',
                    { className: 'ld_endpoint', key: row.key },
                    h('span', { className: 'ld_chip' }, row.label),
                    h('code', null, row.entry.baseURL || '(unset)'),
                    h('span', { className: 'ld_small' }, row.entry.model || '(unset)'),
                    h('span', { className: 'ld_badge ' + view.badge }, view.label),
                    row.entry.latencyMs !== null && row.entry.latencyMs !== undefined
                      ? h('span', { className: 'ld_small' }, String(row.entry.latencyMs) + 'ms')
                      : null,
                    row.entry.error ? h('span', { className: 'ld_small' }, String(row.entry.error).slice(0, 180)) : null,
                  )
                }),
              ),
              fallbacks.length === 0 ? h('div', { className: 'ld_small' }, t('healthNoFallbacks')) : null,
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

    function SubagentCard({ t, piReady, subReady, routeRegistered, subAllowed, busy, notice, onEnable, onDisable, savedEndpoint }) {
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
        notice ? h('div', { className: 'ld_msg ' + (notice.kind || ''), role: 'status' }, notice.text) : null,
        !available
          ? h('div', { className: 'ld_small' }, 'llm-pi-ai: ' + (piReady ? 'ready' : 'unavailable') + ' · ' + 'subagent-model-selection-settings: ' + (subReady ? 'ready' : 'unavailable'))
          : null,
      )
    }

    /* ── 0.4.0: local AI involvement levels ──────────────────────────────── */

    function LevelsCard({
      t,
      current,
      disabled,
      update,
      levelsInfo,
      levelsError,
      onRefreshLevels,
      routeRegistered,
      endpointModel,
      listValue,
      onListChange,
      onWorkspaceLevel,
    }) {
      const config = current || {}
      const levelsEnabled = config.levelsEnabled !== false
      const defaultLevel = parseLevel(config.defaultLevel)
      const workspaces = levelsInfo && Array.isArray(levelsInfo.workspaces) ? levelsInfo.workspaces : []
      const levelsUnavailable = Boolean(levelsInfo && levelsInfo.unavailable)
      const routeWarning = usesHighOrMax(config, workspaces) && !routeRegistered
      const workspaceRows = workspaces.map((workspace, index) => {
        const workspacePath = String((workspace && workspace.path) || '')
        const override = findWorkspaceLevel(config.workspaceLevels, workspacePath)
        const title = String((workspace && workspace.title) || workspacePath || '(workspace)')
        const options = [{ value: '', label: t('levelsInherit') + ' · ' + levelOptionLabel(t, defaultLevel) }].concat(levelSelectOptions(t))
        return h(
          'div',
          { className: 'ld_levelrow', key: workspacePath || 'workspace-' + index },
          h(
            'div',
            { className: 'ld_grow' },
            h('div', { className: 'ld_name' }, title),
            h('div', { className: 'ld_small' }, workspacePath || '(no path)'),
          ),
          h(Select, {
            value: override,
            disabled: disabled || !workspacePath,
            options,
            onChange: value => onWorkspaceLevel(workspacePath, value),
          }),
        )
      })
      return h(
        'section',
        { className: 'ld_card' },
        h('h3', null, t('levels')),
        h('div', { className: 'ld_small' }, t('levelsHint')),
        h(
          'div',
          { className: 'ld_row' },
          h(
            Field,
            { label: t('levelsDefault'), hint: t('levelsDefaultHint') },
            h(Select, {
              value: defaultLevel,
              disabled,
              options: levelSelectOptions(t),
              onChange: value => update(['defaultLevel'], value),
            }),
          ),
          h(
            Field,
            { hint: t('levelsEnabledHint') },
            h(Checkbox, {
              checked: levelsEnabled,
              disabled,
              label: t('levelsEnabled'),
              onChange: value => update(['levelsEnabled'], value),
            }),
          ),
          h(
            Field,
            { hint: t('composerLevelHint') },
            h(Checkbox, {
              checked: config.composerLevelPicker !== false,
              disabled,
              label: t('composerLevel'),
              onChange: value => update(['composerLevelPicker'], value),
            }),
          ),
        ),
        !levelsEnabled ? h('div', { className: 'ld_msg warn' }, t('levelsDisabledNote')) : null,
        routeWarning ? h('div', { className: 'ld_msg warn' }, t('levelsNeedsRoute')) : null,
        h('div', { className: 'ld_small' }, t('levelsTeamNote')),
        h(
          'details',
          { className: 'ld_fold' },
          h('summary', null, t('levelsWorkspaces') + ' · ' + String(workspaceRows.length) + (levelsError || levelsUnavailable ? ' (!)' : '')),
          h(
            'div',
            { className: 'ld_actions', style: { marginTop: '10px' } },
            h(
              'button',
              { type: 'button', className: 'ld_btn', disabled, onClick: () => void onRefreshLevels() },
              t('levelsRefresh'),
            ),
          ),
          h('div', { className: 'ld_small' }, t('levelsWorkspacesHint')),
          levelsError ? h('div', { className: 'ld_msg err' }, format(t('levelsLoadFailed'), { error: levelsError })) : null,
          levelsUnavailable ? h('div', { className: 'ld_msg warn' }, t('levelsUnavailable')) : null,
          workspaceRows.length > 0
            ? h('div', { className: 'ld_nodes' }, workspaceRows)
            : h('div', { className: 'ld_msg' }, t('levelsNoWorkspaces') + ' ' + t('levelsNoWorkspacesHint')),
        ),
        h(
          'details',
          { className: 'ld_fold' },
          h('summary', null, t('levelsAdvanced')),
          h(
            'div',
            { className: 'ld_row', style: { marginTop: '10px' } },
            h(
              Field,
              { label: t('workerPreset'), hint: t('workerPresetHint') },
              h(TextInput, {
                value: config.workerPreset,
                disabled,
                placeholder: 'standard',
                onChange: value => update(['workerPreset'], value),
              }),
            ),
            h(
              Field,
              { label: t('workerProvider'), hint: t('workerProviderHint') },
              h(TextInput, {
                value: config.workerProvider,
                disabled,
                placeholder: 'spawn',
                onChange: value => update(['workerProvider'], value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'ld_row', style: { marginTop: '10px' } },
            h(
              Field,
              { label: t('workerRouteProvider'), hint: t('workerRouteProviderHint') },
              h(TextInput, {
                value: config.workerRouteProvider,
                disabled,
                placeholder: ROUTE_PROVIDER,
                onChange: value => update(['workerRouteProvider'], value),
              }),
            ),
            h(
              Field,
              { label: t('workerRouteModel'), hint: t('workerRouteModelHint') },
              h(TextInput, {
                value: config.workerRouteModel,
                disabled,
                placeholder: endpointModel || '(endpoint model)',
                onChange: value => update(['workerRouteModel'], value),
              }),
            ),
            h(
              Field,
              { label: t('workerMaxDepth'), hint: t('workerMaxDepthHint') },
              h(NumberInput, {
                value: config.workerMaxDepth,
                disabled,
                min: 1,
                max: 5,
                onChange: value => update(['workerMaxDepth'], value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'ld_row', style: { marginTop: '10px' } },
            h(
              Field,
              { label: t('plannerFallback') },
              h(Select, {
                value: PLANNER_FALLBACK_VALUES.includes(String(config.plannerFallback)) ? config.plannerFallback : 'strong-worker',
                disabled,
                options: [
                  { value: 'strong-worker', label: t('plannerFallbackStrong') },
                  { value: 'fail', label: t('plannerFallbackFail') },
                ],
                onChange: value => update(['plannerFallback'], value),
              }),
            ),
            h(
              Field,
              { label: t('lightMinChars'), hint: t('lightMinCharsHint') },
              h(NumberInput, { value: config.lightMinChars, disabled, min: 1, onChange: value => update(['lightMinChars'], value) }),
            ),
            h(
              Field,
              { label: t('lightMinFiles'), hint: t('lightMinFilesHint') },
              h(NumberInput, { value: config.lightMinFiles, disabled, min: 1, onChange: value => update(['lightMinFiles'], value) }),
            ),
            h(
              Field,
              { label: t('highMinChars'), hint: t('highMinCharsHint') },
              h(NumberInput, { value: config.highMinChars, disabled, min: 1, onChange: value => update(['highMinChars'], value) }),
            ),
          ),
          h(
            'div',
            { className: 'ld_row', style: { marginTop: '10px' } },
            h(
              Field,
              { label: t('plannerDenyExtra'), hint: t('plannerListHint') },
              h(TextInput, {
                value: listValue('plannerDenyExtra'),
                disabled,
                onChange: value => onListChange('plannerDenyExtra', value),
              }),
            ),
            h(
              Field,
              { label: t('plannerAllowExtra'), hint: t('plannerListHint') },
              h(TextInput, {
                value: listValue('plannerAllowExtra'),
                disabled,
                onChange: value => onListChange('plannerAllowExtra', value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'ld_actions', style: { marginTop: '10px' } },
            h(Checkbox, {
              checked: config.plannerAllowRead !== false,
              disabled,
              label: t('plannerAllowRead'),
              onChange: value => update(['plannerAllowRead'], value),
            }),
            h(Checkbox, {
              checked: config.applyToLiveAgents === true,
              disabled,
              label: t('applyToLiveAgents'),
              onChange: value => update(['applyToLiveAgents'], value),
            }),
          ),
          h('div', { className: 'ld_small' }, t('plannerAllowReadHint')),
          h('div', { className: 'ld_small' }, t('applyToLiveAgentsHint')),
        ),
      )
    }

    /* ── 0.4.0: SlaveAgentTeams node pool ────────────────────────────────── */

    function SlaveTeamsCard({
      t,
      current,
      disabled,
      update,
      piReady,
      providers,
      routeRegistered,
      endpointModel,
      autoInfo,
      autoError,
      autoDiscover = true,
      autoBusy,
      onRefreshAuto,
      onSyncRoutes,
      onSetNode,
      onAddNode,
      onRemoveNode,
      onFillLocalNode,
    }) {
      const config = current || {}
      const enabled = config.slaveTeamsEnabled === true
      const nodes = nodesOf(config)
      const autoMode = enabled && nodes.length === 0 && autoDiscover !== false
      const effectiveModel = node => String((node && node.model) || endpointModel || '').trim()
      const isChainProvider = node => {
        const provider = String((node && node.provider) || '').trim()
        return provider === ROUTE_PROVIDER || provider.startsWith(ROUTE_PROVIDER + '-fb')
      }
      const detectedAll = autoInfo && Array.isArray(autoInfo.detected)
        ? autoInfo.detected
        : autoInfo && Array.isArray(autoInfo.nodes)
          ? autoInfo.nodes
          : []
      const chainDetected = detectedAll.filter(isChainProvider)
      // Prefer the endpoint-chain routes when they exist; otherwise keep every
      // mounted route so auto mode still works before a chain route is synced.
      const detected = chainDetected.length > 0 ? chainDetected : detectedAll
      const otherDetected = chainDetected.length > 0 ? detectedAll.filter(node => !isChainProvider(node)) : []
      const nodeKey = node => `${String((node && node.provider) || '').trim()}\u0000${effectiveModel(node)}`
      const selectedKeys = new Set(nodes.map(nodeKey))
      const implicitAll = enabled && nodes.length === 0 && autoDiscover !== false
      const isDetectedSelected = node => implicitAll || selectedKeys.has(nodeKey(node))
      const selectedDetectedCount = detected.filter(isDetectedSelected).length
      const toSlaveNode = (node, base) => {
        const provider = String((node && node.provider) || '').trim()
        const model = effectiveModel(node)
        return {
          name: uniqueSlaveName(base, String((node && node.name) || '').trim() || provider + '/' + model),
          kind: node && node.kind === 'cloud' ? 'cloud' : 'local',
          provider,
          model,
          note: String((node && node.note) || ''),
        }
      }
      const toggleDetected = (node, checked) => {
        let next = implicitAll ? [] : nodes.map(entry => ({ ...entry }))
        if (implicitAll) {
          for (const entry of detected) next.push(toSlaveNode(entry, next))
        }
        const key = nodeKey(node)
        if (checked) {
          if (!next.some(entry => nodeKey(entry) === key)) next.push(toSlaveNode(node, next))
        } else {
          next = next.filter(entry => nodeKey(entry) !== key)
        }
        update(['slaveNodes'], next)
      }
      const selectAllDetected = () => {
        const next = []
        for (const entry of nodes) {
          if (!next.some(node => nodeKey(node) === nodeKey(entry))) next.push({ ...entry, model: effectiveModel(entry) })
        }
        for (const entry of detected) {
          if (!next.some(node => nodeKey(node) === nodeKey(entry))) next.push(toSlaveNode(entry, next))
        }
        update(['slaveNodes'], next)
      }

      const detectedProviders = autoInfo && Array.isArray(autoInfo.providers) ? autoInfo.providers : []
      const catalogById = new Map()
      for (const entry of Array.isArray(providers) ? providers : []) catalogById.set(entry.id, { id: entry.id, models: [...(entry.models || [])] })
      for (const entry of detectedProviders) {
        const id = String(entry && entry.id || '').trim()
        if (!id) continue
        const existing = catalogById.get(id) || { id, models: [] }
        const models = new Set([...(existing.models || []), ...(Array.isArray(entry.models) ? entry.models : [])])
        catalogById.set(id, { id, models: [...models] })
      }
      const catalog = [...catalogById.values()].sort((left, right) => left.id.localeCompare(right.id))
      const providerIds = catalog.map(entry => entry.id)
      const providerSet = new Set(providerIds)
      const nodeNames = nodes.map(node => String(node.name || '').trim()).filter(Boolean)
      const defaultNode = String(config.slaveTeamDefaultNode || '')
      const hasLocalNode = nodes.some(node => String((node && node.provider) || '').trim() === ROUTE_PROVIDER)
      const localRouteMissing = !autoMode && !routeRegistered && (hasLocalNode || (enabled && nodes.length === 0))
      const unregistered = piReady
        ? nodes.filter(node => {
            const provider = String((node && node.provider) || '').trim()
            return provider && provider !== ROUTE_PROVIDER && !providerSet.has(provider)
          })
        : []
      const unknownModel = piReady
        ? nodes.filter(node => {
            const provider = String((node && node.provider) || '').trim()
            const model = String((node && node.model) || '').trim()
            if (!provider || !model) return false
            const entry = catalogById.get(provider)
            return Boolean(entry && Array.isArray(entry.models) && entry.models.length > 0 && !entry.models.includes(model))
          })
        : []
      const cleanSlaveNodes = () => {
        const next = []
        for (const node of nodes) {
          const provider = String((node && node.provider) || '').trim()
          const model = effectiveModel(node)
          if (!provider || !model) continue
          if (next.some(entry => nodeKey(entry) === `${provider}\u0000${model}`)) continue
          const entry = catalogById.get(provider)
          if (entry && Array.isArray(entry.models) && entry.models.length > 0 && !entry.models.includes(model)) continue
          const name = uniqueSlaveName(next, String((node && node.name) || '').trim() || `${provider}/${model}`)
          next.push({ ...node, model, name })
        }
        update(['slaveNodes'], next)
      }
      const autoIssues = autoInfo && Array.isArray(autoInfo.issues) ? autoInfo.issues : []
      const autoProvidersCount = new Set(detected.map(node => String((node && node.provider) || '').trim()).filter(Boolean)).size
      const otherDetectedProviders = [...new Set(otherDetected.map(node => String((node && node.provider) || '').trim()).filter(Boolean))]
      const implicitNode = ROUTE_PROVIDER + '/' + (endpointModel || '(model unset)')
      const defaultNodeOptions = [{ value: '', label: t('slaveRoundRobin') }].concat(
        nodeNames.map(name => ({ value: name, label: name })),
      )
      if (defaultNode && !nodeNames.includes(defaultNode)) defaultNodeOptions.push({ value: defaultNode, label: defaultNode + ' (!)' })
      const nodeRows = nodes.map((node, index) => {
        const provider = String(node.provider || '').trim()
        const entry = catalog.find(candidate => candidate.id === provider)
        const modelOptions = entry && Array.isArray(entry.models) ? entry.models : []
        return h(
          'div',
          { className: 'ld_node', key: 'slave-node-' + index },
          h(
            'div',
            { className: 'ld_node_head' },
            h('span', { className: 'ld_chip' }, (node.kind === 'cloud' ? t('slaveNodeCloud') : t('slaveNodeLocal')) + ' #' + String(index + 1)),
            h('span', { className: 'ld_small' }, (provider || '(provider unset)') + ' / ' + (String(node.model || '').trim() || '(default model)')),
            h(
              'button',
              { type: 'button', className: 'ld_btn danger', disabled, onClick: () => onRemoveNode(index) },
              t('slaveRemoveNode'),
            ),
          ),
          h(
            'div',
            { className: 'ld_row' },
            h(
              Field,
              { label: t('slaveNodeName'), hint: t('slaveNodeNameHint') },
              h(TextInput, {
                value: node.name,
                disabled,
                placeholder: 'local',
                onChange: value => onSetNode(index, 'name', value),
              }),
            ),
            h(
              Field,
              { label: t('slaveNodeKind') },
              h(Select, {
                value: SLAVE_KINDS.includes(String(node.kind)) ? node.kind : 'local',
                disabled,
                options: [
                  { value: 'local', label: t('slaveNodeLocal') },
                  { value: 'cloud', label: t('slaveNodeCloud') },
                ],
                onChange: value => onSetNode(index, 'kind', value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'ld_row' },
            h(
              Field,
              { label: t('slaveNodeProvider'), hint: t('slaveNodeProviderHint') },
              h(TextInput, {
                value: node.provider,
                disabled,
                list: 'ld-slave-providers',
                placeholder: ROUTE_PROVIDER,
                onChange: value => onSetNode(index, 'provider', value),
              }),
            ),
            h(
              Field,
              { label: t('slaveNodeModel'), hint: t('slaveNodeModelHint') },
              h(TextInput, {
                value: node.model,
                disabled,
                list: 'ld-slave-models-' + index,
                placeholder: endpointModel || 'gemma4:e2b',
                onChange: value => onSetNode(index, 'model', value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'ld_row' },
            h(
              Field,
              { label: t('slaveNodeNote'), hint: t('slaveNodeNoteHint') },
              h(TextInput, { value: node.note, disabled, onChange: value => onSetNode(index, 'note', value) }),
            ),
          ),
          h(
            'datalist',
            { id: 'ld-slave-models-' + index },
            modelOptions.map(modelId => h('option', { key: modelId, value: modelId })),
          ),
        )
      })
      const discoveryActions = h(
        'div',
        { className: 'ld_actions', style: { marginTop: '6px' } },
        h(
          'button',
          { type: 'button', className: 'ld_btn', disabled: disabled || autoBusy, onClick: () => void onRefreshAuto() },
          autoBusy ? t('loading') : t('slaveAutoRefresh'),
        ),
        h(
          'button',
          { type: 'button', className: 'ld_btn', disabled: disabled || !piReady || autoBusy, onClick: () => void onSyncRoutes() },
          t('slaveAutoSyncNow'),
        ),
      )
      return h(
        'section',
        { className: 'ld_card' },
        h(
          'div',
          { className: 'ld_head' },
          h('h3', null, t('slaveTeams')),
          h('span', { className: 'grow' }),
          h(Checkbox, {
            checked: enabled,
            disabled,
            label: t('slaveTeamsEnable'),
            onChange: value => update(['slaveTeamsEnabled'], value),
          }),
        ),
        h('div', { className: 'ld_small' }, t('slaveTeamsShortHint')),
        !enabled
          ? h('div', { className: 'ld_msg' }, t('slaveDisabledHint'))
          : h(
              'div',
              { className: 'ld_auto' },
              localRouteMissing ? h('div', { className: 'ld_msg warn' }, t('slaveRouteMissing')) : null,
              unregistered.length > 0
                ? unregistered.map((node, index) =>
                    h(
                      'div',
                      { className: 'ld_msg warn', key: 'slave-unregistered-' + index },
                      format(t('slaveProviderUnregistered'), { name: String(node.name || '?'), provider: String(node.provider || '') }),
                    ),
                  )
                : null,
              unknownModel.length > 0
                ? unknownModel.map((node, index) =>
                    h(
                      'div',
                      { className: 'ld_msg warn', key: 'slave-unknown-model-' + index },
                      format(t('slaveModelUnregistered'), {
                        name: String(node.name || '?'),
                        provider: String(node.provider || ''),
                        model: String(node.model || ''),
                      }),
                    ),
                  )
                : null,
              nodes.length === 0 && autoDiscover === false
                ? h('div', { className: 'ld_msg warn' }, format(t('slaveImplicitNode'), { node: implicitNode }))
                : null,
              detected.length > 0
                ? h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'ld_kv' },
                      h('span', null, h('strong', null, t('slaveAvailable'))),
                      h('span', null, format(t('slaveAvailableSelected'), { selected: selectedDetectedCount, total: detected.length })),
                      autoMode ? h('span', { className: 'ld_badge' }, t('slaveAutoMode')) : null,
                    ),
                    h('div', { className: 'ld_small' }, format(t('slaveAutoDetected'), { count: autoProvidersCount, nodes: detected.length })),
                    h(
                      'div',
                      { className: 'ld_available' },
                      detected.slice(0, MAX_SLAVE_NODES).map((node, index) =>
                        h(
                          'label',
                          { className: 'ld_available_row', key: 'slave-available-' + index },
                          h('input', {
                            type: 'checkbox',
                            checked: isDetectedSelected(node),
                            disabled,
                            onChange: event => toggleDetected(node, event.target.checked),
                          }),
                          h('span', { className: 'ld_chip' }, node.kind === 'cloud' ? t('slaveNodeCloud') : t('slaveNodeLocal')),
                          h('code', null, String(node.provider || '') + '/' + String(node.model || '')),
                          h('span', { className: 'ld_small' }, String(node.name || '')),
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'ld_actions', style: { marginTop: '6px' } },
                      h(
                        'button',
                        { type: 'button', className: 'ld_btn', disabled, onClick: selectAllDetected },
                        t('slaveSelectAll'),
                      ),
                      discoveryActions,
                    ),
                  )
                : h(
                    'div',
                    null,
                    h('div', { className: 'ld_msg warn' }, autoMode ? t('slaveAutoEmpty') : t('slaveAvailableEmpty')),
                    discoveryActions,
                  ),
              autoError ? h('div', { className: 'ld_msg warn' }, String(autoError)) : null,
              h(
                'details',
                { className: 'ld_fold', style: { marginTop: '10px' } },
                h('summary', null, t('slaveAdvanced')),
                h(
                  'div',
                  { className: 'ld_actions' },
                  h(Checkbox, {
                    checked: autoDiscover !== false,
                    disabled,
                    label: t('slaveAutoDiscover'),
                    onChange: value => update(['slaveTeamAutoDiscover'], value),
                  }),
                ),
                h('div', { className: 'ld_small' }, t('slaveAutoDiscoverHint')),
                autoDiscover === false ? h('div', { className: 'ld_small' }, t('slaveAutoOffHint')) : null,
                otherDetected.length > 0
                  ? h(
                      'div',
                      { className: 'ld_small' },
                      format(t('slaveOtherRoutesHint'), {
                        count: otherDetected.length,
                        providers: otherDetectedProviders.join(', '),
                      }),
                    )
                  : null,
                autoIssues.length > 0
                  ? h('div', { className: 'ld_small' }, format(t('slaveAutoIssues'), { issues: autoIssues.slice(0, 3).join('; ') }))
                  : null,
                h(
                  'div',
                  { className: 'ld_row', style: { marginTop: '10px' } },
                  h(
                    Field,
                    { label: t('slaveDefaultNode') },
                    h(Select, {
                      value: defaultNode,
                      disabled,
                      options: defaultNodeOptions,
                      onChange: value => update(['slaveTeamDefaultNode'], value),
                    }),
                  ),
                  h(
                    Field,
                    { label: t('slaveMaxSlaves'), hint: t('slaveMaxSlavesHint') },
                    h(NumberInput, {
                      value: config.slaveTeamMaxSlaves,
                      disabled,
                      min: 1,
                      max: MAX_SLAVES,
                      onChange: value => update(['slaveTeamMaxSlaves'], value),
                    }),
                  ),
                  h(
                    Field,
                    { label: t('slavePreset') },
                    h(TextInput, {
                      value: config.slaveTeamPreset,
                      disabled,
                      placeholder: 'standard',
                      onChange: value => update(['slaveTeamPreset'], value),
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'ld_row' },
                  h(
                    Field,
                    { label: t('slaveFallback') },
                    h(Select, {
                      value: SLAVE_FALLBACK_VALUES.includes(String(config.slaveTeamFallback)) ? config.slaveTeamFallback : 'inherit',
                      disabled,
                      options: [
                        { value: 'inherit', label: t('slaveFallbackInherit') },
                        { value: 'fail', label: t('slaveFallbackFail') },
                      ],
                      onChange: value => update(['slaveTeamFallback'], value),
                    }),
                  ),
                  h(
                    Field,
                    { label: t('slaveProvider'), hint: t('slaveProviderHint') },
                    h(TextInput, {
                      value: config.slaveTeamProvider,
                      disabled,
                      placeholder: 'spawn',
                      onChange: value => update(['slaveTeamProvider'], value),
                    }),
                  ),
                  h(
                    Field,
                    { label: t('slaveMaxDepth'), hint: t('slaveMaxDepthHint') },
                    h(NumberInput, {
                      value: config.slaveTeamMaxDepth,
                      disabled,
                      min: 1,
                      max: 5,
                      onChange: value => update(['slaveTeamMaxDepth'], value),
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'ld_actions', style: { marginTop: '8px' } },
                  h(Checkbox, {
                    checked: config.slaveTeamPromptHelp !== false,
                    disabled,
                    label: t('slavePromptHelp'),
                    onChange: value => update(['slaveTeamPromptHelp'], value),
                  }),
                ),
                h(
                  'details',
                  { className: 'ld_fold', style: { marginTop: '10px' } },
                  h('summary', null, t('slaveNodes') + ' · ' + String(nodes.length) + (autoMode ? ' · ' + t('slaveNodesOptional') : '')),
                  h('div', { className: 'ld_small' }, t('slaveNodesHint')),
                  h(
                    'div',
                    { className: 'ld_nodes' },
                    nodeRows,
                    h(
                      'div',
                      { className: 'ld_actions' },
                      h('button', { type: 'button', className: 'ld_btn', disabled, onClick: () => void onAddNode() }, t('slaveAddNode')),
                      h('button', { type: 'button', className: 'ld_btn', disabled, onClick: () => void onFillLocalNode() }, t('slaveFillLocal')),
                      h('button', { type: 'button', className: 'ld_btn', disabled: disabled || nodes.length === 0, onClick: cleanSlaveNodes }, t('slaveCleanNodes')),
                      nodes.length > MAX_SLAVE_NODES ? h('span', { className: 'ld_small' }, t('slaveNodeLimit')) : null,
                    ),
                  ),
                  h('datalist', { id: 'ld-slave-providers' }, providerIds.map(id => h('option', { key: id, value: id }))),
                ),
                h('div', { className: 'ld_small' }, t('slaveCompatNote')),
                h('div', { className: 'ld_small' }, t('slaveToolsNote')),
              ),
            ),
      )
    }


    function StatsCard({ t, stats, onRefresh }) {
      const workerCounts = {
        started: Number(stats && stats.workersStarted) || 0,
        failed: Number(stats && stats.workersFailed) || 0,
        slaves: Number(stats && stats.slavesStarted) || 0,
        settled: Number(stats && stats.slavesSettled) || 0,
        slaveFailed: Number(stats && stats.slavesFailed) || 0,
      }
      const hasWorkerActivity =
        workerCounts.started + workerCounts.failed + workerCounts.slaves + workerCounts.settled + workerCounts.slaveFailed > 0
      const hasLocalActivity = Boolean(
        stats && (Number(stats.calls) || 0) + (Number(stats.failed) || 0) + (Number(stats.chunkCalls) || 0) > 0,
      )
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
        hasLocalActivity || hasWorkerActivity
          ? h(
              'div',
              { className: 'ld_grid' },
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.calls)), h('span', null, t('statsCalls'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.failed)), h('span', null, t('statsFailed'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.chunkCalls)), h('span', null, t('statsRequests'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.charsIn + stats.charsOut)), h('span', null, t('statsChars'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.localPromptTokens + stats.localCompletionTokens)), h('span', null, t('statsLocalTokens'))),
              h('div', { className: 'ld_stat' }, h('b', null, fmt(stats.estimatedSavedTokens)), h('span', null, t('statsSaved'))),
              workerCounts.started > 0
                ? h('div', { className: 'ld_stat', key: 'stat-workers' }, h('b', null, fmt(workerCounts.started)), h('span', null, t('statsWorkers')))
                : null,
              workerCounts.failed > 0
                ? h('div', { className: 'ld_stat', key: 'stat-worker-failed' }, h('b', null, fmt(workerCounts.failed)), h('span', null, t('statsWorkersFailed')))
                : null,
              workerCounts.slaves > 0
                ? h('div', { className: 'ld_stat', key: 'stat-slaves' }, h('b', null, fmt(workerCounts.slaves)), h('span', null, t('statsSlaves')))
                : null,
              workerCounts.settled > 0
                ? h('div', { className: 'ld_stat', key: 'stat-slaves-settled' }, h('b', null, fmt(workerCounts.settled)), h('span', null, t('statsSlavesSettled')))
                : null,
              workerCounts.slaveFailed > 0
                ? h('div', { className: 'ld_stat', key: 'stat-slaves-failed' }, h('b', null, fmt(workerCounts.slaveFailed)), h('span', null, t('statsSlavesFailed')))
                : null,
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
                  h('span', { key: task }, h('code', null, TASK_LABELS[task] || task), ' ×' + fmt(stats.byTask[task].calls)),
                ),
            )
          : null,
        stats && stats.byNode && Object.keys(stats.byNode).length > 0
          ? h(
              'div',
              { className: 'ld_kv' },
              h('span', null, t('statsByNode') + ':'),
              Object.keys(stats.byNode)
                .sort()
                .slice(0, 8)
                .map(node => {
                  const entry = stats.byNode[node]
                  const count = typeof entry === 'number' ? entry : Number(entry && (entry.started !== undefined ? entry.started : entry.count)) || 0
                  return h('span', { key: node }, h('code', null, node), ' ×' + fmt(count))
                }),
            )
          : null,
      )
    }

    /* ── composer level picker ──────────────────────────────────────────── */

    /**
     * Compact level switcher rendered in the conversation composer tool row
     * (`conversation.input.left`), next to the model / reasoning controls.
     *
     * The quick edit writes the same profile config the settings page writes:
     * a workspace override when the current session belongs to a workspace, or
     * the global default level otherwise. It renders nothing unless the level
     * policy AND `composerLevelPicker` are enabled.
     */
    function ComposerLevelPicker(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const form = props.form
      const useWorkspaces = props.useWorkspaces
      const snap = form ? useSnapshot(form) : null
      let workspaces = []
      if (typeof useWorkspaces === 'function') {
        try {
          workspaces = useWorkspaces(state => (state && state.items) || []) || []
        } catch {
          workspaces = []
        }
      }
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const rootRef = useRef(null)

      useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const onPointerDown = event => {
          const root = rootRef.current
          if (root && typeof root.contains === 'function' && root.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      useEffect(() => {
        if (!error) return undefined
        const timer = setTimeout(() => setError(''), 6000)
        return () => clearTimeout(timer)
      }, [error])

      if (!form || !snap || snap.status !== 'ready') return null
      const config = snap.value || {}
      const workspace = resolveComposerWorkspace(workspaces, props.sessionId)
      const model = composerLevelModel(config, workspace, t)
      if (!model) return null
      const writable = snap.writable !== false
      const selectedValue = model.mode === 'workspace' ? model.override || '' : model.defaultLevel

      const toggle = () => {
        if (!open) {
          const root = rootRef.current
          if (root && typeof root.getBoundingClientRect === 'function' && typeof window !== 'undefined') {
            const rect = root.getBoundingClientRect()
            setAnchor({
              left: Math.max(8, rect.left),
              bottom: Math.max(8, (window.innerHeight || 0) - rect.top + 6),
            })
          }
        }
        setOpen(value => !value)
      }

      const choose = async value => {
        setOpen(false)
        setError('')
        const ops =
          model.mode === 'workspace'
            ? [{ op: 'set', path: ['workspaceLevels'], value: withWorkspaceLevel(config.workspaceLevels, model.workspacePath, value) }]
            : [{ op: 'set', path: ['defaultLevel'], value: value || 'default' }]
        setBusy(true)
        try {
          const accepted = await form.mutate(ops, snap.revision)
          if (!accepted) setError(t('composerLevelConflict'))
        } catch (failure) {
          setError(
            format(t('composerLevelSaveFailed'), {
              error: String((failure && failure.message) || failure).slice(0, 160),
            }),
          )
        } finally {
          setBusy(false)
        }
      }

      const title =
        model.mode === 'workspace'
          ? t('composerLevelTitle') + ' · ' + (model.workspaceLabel || model.workspacePath)
          : t('composerLevelTitle') + ' · ' + t('composerLevelDefaultMode')
      return h(
        'div',
        { className: 'ld_composer', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'ld_composer_trigger',
            disabled: busy || !writable,
            title,
            onClick: toggle,
          },
          h('span', { className: 'ld_composer_label' }, t('composerLevelShort')),
          h(
            'span',
            { className: 'ld_composer_value' },
            levelOptionLabel(t, model.value) + (model.mode === 'workspace' && model.override ? ' *' : ''),
          ),
          h('span', { className: 'ld_composer_chevron' }, '▾'),
        ),
        error ? h('span', { className: 'ld_composer_err', title: error }, '⚠') : null,
        open
          ? h(
              'div',
              {
                className: 'ld_composer_menu',
                style: anchor
                  ? { left: anchor.left + 'px', bottom: anchor.bottom + 'px' }
                  : { left: '0px', bottom: '34px' },
              },
              h('div', { className: 'ld_composer_head' }, t('composerLevelMenuTitle')),
              model.mode === 'workspace'
                ? h(
                    'div',
                    { className: 'ld_composer_note' },
                    t('composerLevelWorkspace') +
                      ': ' +
                      (model.workspaceLabel || model.workspacePath) +
                      (model.override ? '' : ' · ' + t('composerLevelInherit')),
                  )
                : h('div', { className: 'ld_composer_note' }, t('composerLevelDefaultMode')),
              model.options.map(option =>
                h(
                  'button',
                  {
                    key: 'level-' + (option.value || 'inherit'),
                    type: 'button',
                    className: 'ld_composer_item' + (option.value === selectedValue ? ' on' : ''),
                    onClick: () => void choose(option.value),
                  },
                  h('span', { className: 'ld_composer_check' }, option.value === selectedValue ? '✓' : ''),
                  h('span', null, option.label),
                ),
              ),
              h('div', { className: 'ld_composer_note' }, t('composerLevelNewSession')),
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

      // Composer quick level picker: a compact control in the composer tool
      // row, next to the model / reasoning controls. The component itself
      // renders nothing while `composerLevelPicker` or `levelsEnabled` is off.
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'local-delegate-level-picker',
            order: 30,
            locale: NS,
            inject: () => ({ t: tr, form }),
          },
          ComposerLevelPicker,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'configForms']
    exports.name = 'local-delegate-settings'
    exports.Page = Page
    exports.__test = {
      Page,
      HealthCard,
      ProbeResult,
      SubagentCard,
      LevelsCard,
      SlaveTeamsCard,
      StatsCard,
      ComposerLevelPicker,
      buildOps,
      buildPiProvider,
      buildChainUnrouteOps,
      chainRouteIds,
      validateEndpointNumbers,
      buildSlaveNode,
      groupChainEndpoints,
      chainRouteProviderId,
      buildChainRouteOps,
      missingChainModels,
      levelSelectOptions,
      findWorkspaceLevel,
      withWorkspaceLevel,
      resolveComposerWorkspace,
      composerLevelModel,
      listToText,
      textToList,
      providerCatalog,
    }
    return module.exports
  },
})




