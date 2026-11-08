# dsh-local-bridge

A **DeepSeek Harness (dsh) plugin project** that turns your own, logged-in **WorkBuddy desktop** account into a local, OpenAI-compatible model provider for DSH — with no third-party gateway and no API key to copy around.

This repository contains two things in one clone:

| Path | What it is |
|---|---|
| [`bundle/`](bundle/) | The **DSH plugin bundle** — a configuration-only Cordis bundle that registers the local endpoint as an `llm-pi-ai` provider (the part that shows up in DSH's Plugin Manager). |
| [`bridge/`](bridge/) | The **bridge service** — a standalone, auditable Node.js process that reads WorkBuddy's encrypted login state on your machine and exposes `http://127.0.0.1:8791/v1` (`/healthz`, `/v1/models`, `/v1/chat/completions`). |

```
DSH  (@deepseek-ai/dsh-llm-pi-ai, api: openai-completions)
        │  http://127.0.0.1:8791/v1        ← configured by bundle/cordis.patch.yml
        ▼
   bridge/wb-bridge.mjs                    ← this repo, run locally, loopback only
        │  decrypt credential (in memory) + auth headers + scrub fingerprints
        │  + neutral tool names + pass through SSE
        ▼
   copilot.tencent.com  (Bearer <your WorkBuddy accessToken>)
        ▲
   WorkBuddy desktop app login state (read-only, never modified)
```

> Both halves are needed. Installing the bundle alone only teaches DSH *where* to call; the bridge is the process that actually answers. The bridge never edits DSH's config, and the bundle never starts the bridge — that separation keeps the whole thing auditable.

---

## On the second computer — quick start

Prerequisites: Windows, **Node.js 22.19+**, **DeepSeek Harness** installed, and the **WorkBuddy desktop app installed and signed in** (the bridge reuses that login; it does not store your password or token on disk).

```powershell
# 1. Get the code
git clone https://github.com/narcissussecond/dsh-local-bridge.git
cd dsh-local-bridge

# 2. Start the bridge (keep the window open / minimized)
.\bridge\start-wb-bridge.cmd

# 3. Sanity check — should print region, credential cache, model count
curl http://127.0.0.1:8791/healthz
```

Then install the plugin bundle into DSH (see [Install the bundle](#install-the-bundle)), and pick **WorkBuddy** as the provider / a model from the list in DSH's model selector.

Optional but recommended on a machine you use daily:

```powershell
# Register logon start + a watchdog + a daily self-check (fills in your SID/paths itself)
powershell -ExecutionPolicy Bypass -File .\bridge\install-tasks.ps1
```

Full details, port/Node overrides, and troubleshooting are in [`bridge/README.md`](bridge/README.md).

---

## Install the bundle

The bundle is a plain directory on disk, so there is no package to publish or build. Pick **one** of the two methods.

### Method A — let DSH install it (recommended)

In a DSH session, ask the agent (or use the Plugin Manager tool):

> Install the local plugin bundle at the absolute path `<clone>\bundle` (a directory).

Concretely that is `plugin_manager` with `action: install_bundle` and `target` set to the absolute path of the `bundle/` directory. DSH links the checkout, reads `dsh.bundle.patch`, and applies `bundle/cordis.patch.yml`. Enable the bundle if it comes up disabled. Restart DSH (or reselect the provider in Settings → Models) to pick up the new model list.

### Method B — copy the config into your profile manually

If you prefer to edit your profile directly, open `~/.dsh/profiles/<profile>/cordis.patch.yml` and merge the `- id: llm-pi-ai` block from [`bundle/cordis.patch.yml`](bundle/cordis.patch.yml). **Do not add a second `llm-pi-ai` row** — it is a single instance whose `config.providers` holds every provider.

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      local-gateway:
        displayName: WorkBuddy
        api: openai-completions
        baseURL: http://127.0.0.1:8791/v1
        headers:
          Authorization: Bearer local-gateway-placeholder   # required but unused locally
        models:
          - id: hy4-preview
            name: Hy4 preview
            contextWindow: 960000
            maxTokens: 64000
            input: [text, image]
            reasoningEfforts: { high: high }
          # ... see bundle/cordis.patch.yml for the full list
    compat:
      supportsDeveloperRole: false
      supportsStore: false
      maxTokensField: max_tokens
      requiresReasoningContentOnAssistantMessages: true
```

> **Layer order:** the profile's own `cordis.patch.yml` is applied *after* every bundle layer. If that file already has an `- id: llm-pi-ai` override, it wins — merge the `providers.local-gateway` block into it rather than relying on the bundle.

The `headers.Authorization` value is a placeholder: `pi-ai` throws `No API key for provider` for a provider with no credential at all, but the local bridge does not validate the value.

---

## Keep the model list current

The model list in `bundle/cordis.patch.yml` was captured from one WorkBuddy account and is account/time specific. The bridge serves whatever upstream offers (10-minute catalog cache), but it deliberately never edits DSH's config. To refresh the declared list on a new machine:

```cmd
node bridge\refresh-models.mjs            :: show the diff, write nothing
node bridge\refresh-models.mjs --apply    :: write (backup + validate first)
```

After writing, restart DSH (or reselect the provider) to load the new list. `node bridge\probe-models.mjs` dumps the full upstream catalog. See the "上游模型变了怎么办" section of [`bridge/README.md`](bridge/README.md) for `--prune` / `--restyle` and the safety rails.

---

## What the bridge actually does (why it isn't a trivial proxy)

The upstream endpoint is an internal, interactive-use API, not a public OpenAI API. The bridge exists to bridge that gap. Its [`bridge/README.md`](bridge/README.md) documents the details; the short version:

- **Encrypted credentials** — WorkBuddy 5.6+ wraps `auth.accessToken` in `{$wbEncrypted:1, envelope}`. The key lives on the machine and is only reachable through WorkBuddy's own Electron binary (`ELECTRON_RUN_AS_NODE=1`, private `workbuddyStorage` binding). AES-256-GCM is opened **in memory**; tokens/keys are never written to disk or logged.
- **Only streaming upstream** — non-stream requests are aggregated from SSE into a standard `chat.completion`.
- **Client-fingerprint scrubbing** — known agent-framework phrases anywhere in any message are removed (`CONTENT_SCRUBS` / `scrubFingerprints()`), and DSH-specific tool names are bi-directionally renamed (`tool-rename.mjs`, 54 rules) so upstream sees neutral names. Functionality is preserved; only the wire names change.
- **Explicit context windows** — every `models[]` entry declares `contextWindow`, or `pi-ai` rejects long sessions locally before sending.
- **Self-healing** — exponential-backoff retry on 429/5xx, 11128 downgrade variants, archived failed request bodies, a 5-minute watchdog, and a daily self-check with real upstream probes and drift detection.

---

## Security boundary and known risks

Read this before using it on the second computer.

- The bridge listens on **`127.0.0.1` only** — never on the network.
- It **reads** WorkBuddy's credential file, never writes it. Tokens and keys are not persisted or printed.
- This repo publishes **code only**: `config.json`, logs, `reports/`, `failed-body-*.json` (which can contain full conversations), and vendored `_yamlpkg/` are excluded by [`bridge/.gitignore`](bridge/.gitignore) and were never committed. Task XML templates use `{{USER_SID}}` / `{{USER_NAME}}` placeholders — no real SID, username, or absolute path is in the repo.
- **Using subscription credits programmatically is not an officially supported WorkBuddy/DSH integration.** Even with fingerprint scrubbing and tool renaming:
  - upstream can add new checks at any time and break it;
  - very large single requests (long sessions) differ from normal interactive use;
  - it may conflict with the WorkBuddy terms of service; account enforcement is upstream's.
- Recommended: one account, one machine, one session at a time; open fresh sessions often; stop at the first non-200.

---

## Repository layout

```
dsh-local-bridge/
├── README.md                  ← this file (plugin + install guide)
├── .gitignore
├── bundle/                    ← the DSH plugin bundle (install this)
│   ├── package.json           ← dsh.bundle.patch manifest + display exports
│   ├── cordis.patch.yml       ← llm-pi-ai provider config override
│   ├── locale/en.json         ← Plugin Manager title/description (EN)
│   ├── locale/zh.json         ← Plugin Manager title/description (ZH)
│   └── icon.svg               ← original artwork
├── bridge/                    ← the standalone Node service (run this)
│   ├── wb-bridge.mjs          ← the server
│   ├── start-wb-bridge.cmd    ← double-click to run
│   ├── install-tasks.ps1      ← logon / watchdog / daily tasks
│   ├── refresh-models.mjs     ← sync the DSH model list
│   ├── probe-models.mjs       ← dump the upstream catalog
│   ├── watchdog.mjs / daily-check.mjs / tool-rename.mjs / config.mjs
│   ├── config.example.json    ← optional per-machine overrides
│   ├── *.task.xml             ← scheduled-task templates (placeholders)
│   ├── test-*.mjs             ← self-tests
│   └── README.md              ← runtime internals + operations
```

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
