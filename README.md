# dsh-local-delegate — delegate mechanical text work to a local cheap model

English | [中文](README.zh-CN.md)

Hand **mechanical text work** (translation, summarization, field extraction, classification, rewriting, commit messages, name candidates) to a local cheap model, while the main model keeps every judgement and tool call.

The point is not "one more model tool" but **where the text travels**: this plugin reads files itself, chunks them, calls the local model, writes the result back — so the whole document **never enters the main model's context**. A 10 KB document translation costs the main model about 150 tokens (one call) instead of about 5,000 (read the source, write the translation).

- Current version: **0.2.1**
- Protocols: Ollama native `/api/chat` (thinking off, keep-alive, context control) or any OpenAI-compatible endpoint
- Install & verify: see [INSTALL.md](INSTALL.md) (versioned install directories let upgrades reload without restarting DSH)

## Repository layout

```
index.js / lib/            Host plugin: tools, endpoint-chain client, chunking, guards, stats
cordis.patch.yml           bundle patch: inserts the plugin row (localhost default; edit before install)
scripts/                   verify-endpoint.mjs (pre-install check), sync-install.ps1 (sync + upgrade)
locale/ · icon.svg         plugin display metadata
docs/design-and-feasibility.md   design, feasibility, measurements (cost model and risks)
examples/                  HTML→Markdown→translate→rebuild localization example scripts
README.md · INSTALL.md     usage and installation manuals
```

## Quick start

```powershell
# 0) get the sources
git clone https://github.com/MythGreenLand/dsh-local-delegate
cd dsh-local-delegate

# 1) verify the endpoint first (installs nothing)
node scripts/verify-endpoint.mjs --base-url http://127.0.0.1:11434 --model gemma4:e2b

# 2) sync to a versioned install directory (PowerShell 7)
pwsh -NoProfile -File scripts/sync-install.ps1

# 3) in a DSH session, ask the agent to run:
#    plugin_manager action=install_bundle target=<directory printed by step 2>

# 4) verify from a session: local_health → local delegate: ready (status: available, v0.2.1)
```

Full steps (verification checklist, configuration, restart-free upgrades, rollback, troubleshooting) are in [INSTALL.md](INSTALL.md).

## Example: localizing an online course

`examples/` contains two dependency-free scripts demonstrating "HTML extraction → plain-text translation → page rebuild" (translating raw HTML directly makes a 5B model break tag structure):

```powershell
node examples/extract-html.mjs <course-dir> <course-dir>/.l10n-src
# ask the agent to translate the Markdown under .l10n-src with local_batch
node examples/build-zh.mjs <course-dir>
```

Measured: 61k source characters across 28 pages, 5.1 minutes, 29.5k local tokens, an estimated ~92% of main-model tokens saved. Details in [docs/design-and-feasibility.md](docs/design-and-feasibility.md).

## Design document

[docs/design-and-feasibility.md](docs/design-and-feasibility.md) records the feasibility analysis, what DeepSeek Harness already provides, the layered delegation design, safety and failure handling, the cost model, the phased plan, and measurements.

## License

MIT, see [LICENSE](LICENSE).

## Tools

| Tool | Purpose |
|---|---|
| `local_transform` | One transformation. **Prefer the `path` file mode**: the plugin reads the file and writes the result back, so the body never enters the conversation; `text` is for short snippets only (≤ `maxInlineChars`) |
| `local_batch` | Batch over several files. Defaults to a **dry run** (plan only); `dry_run: false` executes. Writes under `out_dir` (default `.local-out/`) |
| `local_health` | Probes the whole endpoint chain and returns configuration plus remediation suggestions without generating tokens; the status line includes the plugin version |

Default file-mode output path inserts `.local` into the source name (`README.md` → `README.local.md`). Paths outside the working directory are shown as absolute paths in receipts.

## Availability (0.2.x)

- **Endpoint failover**: `endpoint` primary plus a `fallbackEndpoints` chain; when the primary is unreachable or errors, fallbacks are tried in order and receipts are marked `(fallback)`.
- **Bounded retries**: `retries` (0–3, default 1) only retries transport errors (connection failure, timeout, 5xx, 429); HTTP 4xx (unknown model, bad credential) moves straight to the next endpoint.
- **Startup self-check**: 1.5 s after load the plugin probes once, logging one line per state (available/degraded/unavailable) with a repair hint; it refreshes every 120 s afterwards.
- **Runtime context**: one status line in the system prompt (`available` / `degraded` / `unavailable` + a repair hint); unchanged status is not appended again.
- **`/localdoctor` command**: one-shot report of configuration, endpoint-chain probe, path policy, statistics, and an **actionable remediation list**.
- **Configuration self-check**: empty `model`, non-http(s) `baseURL`, incomplete fallback fields, etc. are logged as warnings at load rather than failing on the first call.

## Configuration reference

Override the `- id: local-delegate` row's `config` in the profile `cordis.patch.yml` (whole-object replacement: restate the fields you want to keep; saves take effect in 1–5 seconds):

```yaml
- id: local-delegate
  name: "dsh-local-delegate"
  config:
    enabled: true
    retries: 1
    endpoint:
      kind: ollama-native            # ollama-native | openai-compatible
      baseURL: http://<ollama-host>:11434
      path: ""                       # defaults to /api/chat or /v1/chat/completions
      model: gemma4:e2b
      apiKey: ""                     # OpenAI-compatible endpoints only
      headers: {}                    # e.g. { Authorization: "Bearer ollama" }
      numCtx: 32768                  # ollama-native
      keepAlive: 30m                 # ollama-native; avoids repeated cold loads
      think: false                   # required false for thinking models
      reasoningEffort: none          # sent as reasoning_effort on openai-compatible
      timeoutMs: 120000
      temperature: 0
      maxOutputTokens: 4096
    fallbackEndpoints:               # tried in order when the primary fails
      - kind: ollama-native
        baseURL: http://127.0.0.1:11434
        model: gemma4:26b
        timeoutMs: 240000
    modelsByTask: {}                 # e.g. { translate: gemma4:e2b, summarize: gemma4:26b }
    maxInlineChars: 8000             # text-mode limit; larger inputs must use file mode
    chunkChars: 4000                 # character limit per model request
    maxConcurrency: 2                # chunk-level concurrency (1–8)
    maxSourceChars: 200000           # per-file limit
    maxBatchFiles: 10                # per-batch file limit
    maxBatchChars: 120000            # per-batch total character limit
    maxResultChars: 6000             # inline-mode body returned to the main model
    maxCallsPerMinute: 40            # local request rate limit
    allowOutsideCwd: false           # true = no path restriction (not recommended)
    allowRoots: []                   # extra allowed roots (absolute or relative to cwd)
    denyGlobs: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/.credentials*", "**/secrets/**", "**/.git/**"]
    promptHelp: true                 # false = do not inject delegation guidance (~300 tokens saved per request)
    warmupOnStart: true              # startup probe + periodic refresh
```

## Usage

Let the main model use it naturally; the injected guidance explains when delegation pays off. Typical requests:

- "Translate `docs/README.md` into Chinese" → the agent calls `local_transform(path=..., target_language=...)`
- "Translate these five Markdown files" → `local_batch` runs a dry run first, then `dry_run: false`
- "This error log is too long, summarize it" → file-mode `summarize`
- "Check whether the local model is available" → `local_health`
- Human diagnostics: `/localdoctor`; usage: `/localstats`

## Security

- **Secret refusal**: private-key blocks, AWS/GitHub/Slack tokens, `sk-…`, JWTs, `password=…` are rejected before any request is sent.
- **Path containment**: by default only the session working directory (or `allowRoots`) is readable/writable; `.env`, key material, `secrets/`, `.git/` are denied by default.
- **No silent retries**: local failures return an actionable error telling the agent to do the work itself, so it does not loop.
- **Atomic writes**: temporary file + rename; output is checked for non-empty content first.
- The local model's output is untrusted: batches default to a dry run; have the main model sample critical files.

## Cost model

| Work | Main model alone | File-mode delegation |
|---|---|---|
| Translate a 10 KB document | ≈5,000 tokens | ≈200 tokens |
| Summarize a 40 KB log | ≈10,600 tokens | ≈500 tokens |
| Batch-add comments to 20 files | ≈26,000 tokens | ≈700 tokens |
| Translate a single sentence | ≈200 tokens | more expensive → guidance tells the model to do it itself |

## Known limitations

- Statistics are in memory (reset on reload); no persistent ledger.
- Batches run synchronously; use `maxBatchChars` / `maxBatchFiles` to bound duration and split very long work.
- Translation joins chunks, so extreme layout (tables, footnotes) is normalized.
- Translating raw HTML risks tag damage (a 5B model was observed adding/dropping closing tags); extract plain text first.
- The plugin runs inside the Host process; path and secret checks are **policy constraints**, not an OS sandbox.
