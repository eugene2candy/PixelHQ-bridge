# pixelhq

[![npm version](https://img.shields.io/npm/v/pixelhq)](https://www.npmjs.com/package/pixelhq)
[![npm provenance](https://img.shields.io/badge/provenance-verified-brightgreen)](https://www.npmjs.com/package/pixelhq#provenance)
[![license](https://img.shields.io/npm/l/pixelhq)](https://github.com/waynedev9598/PixelHQ-bridge/blob/main/LICENSE)

A local bridge server that watches AI coding agent session files and broadcasts lightweight activity events over WebSocket. Designed for the [Pixel Office](https://github.com/waynedev9598/pixel-office) iOS app — a pixel-art visualization of your coding activity.

> **Open source & provenance-verified** — Every npm release is [cryptographically linked](https://www.npmjs.com/package/pixelhq#provenance) to the exact source commit that built it. You can audit the code on [GitHub](https://github.com/waynedev9598/PixelHQ-bridge).

### Supported Agents

- **Claude Code** — fully supported
- **GitHub Copilot CLI** — fully supported
- **Cursor** — coming soon
- **Codex** — coming soon
- **Antigravity** — coming soon
- More to follow

## Quick Start

```bash
npx pixelhq
```

An interactive welcome screen walks you through what the bridge does and how it works. Select **Start bridge** to begin.

Once running, the bridge displays a **6-digit pairing code**. Enter it in the Pixel Office iOS app to connect — the app auto-discovers the server via Bonjour on your local network.

```
  ✓ Claude Code detected at ~/.claude
  ✓ Copilot CLI detected at ~/.copilot
  ✓ WebSocket server on port 8765
  ✓ Broadcasting on local network (192.168.1.100)

  ╔═══════════════════════════════════════╗
  ║         Pairing Code: 847291          ║
  ║                                       ║
  ║  Enter this code in the iOS app to    ║
  ║  connect. Code regenerates on restart. ║
  ╚═══════════════════════════════════════╝

  Waiting for AI coding agent activity...
  Press Ctrl+C to stop
```

For scripts or returning users, skip the interactive menu:

```bash
npx pixelhq --yes
```

## Installation

```bash
# Run without installing
npx pixelhq

# Or install globally
npm install -g pixelhq
pixelhq
```

## CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--port <number>` | WebSocket server port | `8765` |
| `--claude-dir <path>` | Path to Claude config directory | auto-detected |
| `--copilot-dir <path>` | Path to Copilot CLI config directory | auto-detected |
| `--yes`, `-y` | Skip interactive prompts (non-interactive mode) | |
| `--verbose` | Show detailed debug logging | |
| `--help`, `-h` | Show help message | |
| `--version`, `-v` | Show version number | |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PIXEL_OFFICE_PORT` | WebSocket server port (overridden by `--port`) |
| `CLAUDE_CONFIG_DIR` | Claude config directory (overridden by `--claude-dir`) |
| `COPILOT_CONFIG_DIR` | Copilot CLI config directory (overridden by `--copilot-dir`) |

## Requirements

- **Node.js 20+**
- At least one supported AI coding agent installed:
  - **Claude Code** (`~/.claude/projects/`)
  - **GitHub Copilot CLI** (`~/.copilot/session-state/`)
- iOS app on the **same local network** (for Bonjour discovery)

---

## Privacy — Nothing Sensitive Leaves Your Machine

This is a **local-only** server. It binds to your machine, broadcasts only on your local network, and **never contacts any external service**.

The bridge reads raw JSONL session logs — which contain everything: your prompts, file contents, API keys in tool results, thinking text, bash commands, etc. **None of that is broadcast.** Every event goes through a strict privacy-stripping pipeline before it reaches the WebSocket.

### What IS broadcast

Only structural metadata needed to animate the pixel-art office:

| Data | Example | Why |
|------|---------|-----|
| Event type | `"tool"`, `"activity"` | Determines animation |
| Tool category | `"file_read"`, `"terminal"` | Character walks to correct desk |
| Action | `"thinking"`, `"responding"` | Controls character animation |
| Status | `"started"`, `"completed"` | Start/stop animation |
| File basename | `"auth.ts"` | Shows on character's screen |
| Grep/glob pattern | `"TODO"`, `"*.ts"` | Shows on character's screen |
| Bash description | `"Run tests"` | The user-provided label, not the command |
| Agent type | `"explore"`, `"plan"` | Spawns new character |
| Token counts | `{ input: 5000, output: 200 }` | Numbers only |
| Project name | `"pixel-office"` | Last path segment only |
| Timestamps | ISO-8601 | Event ordering |
| Session/event IDs | UUIDs | Correlation |

### What is NOT broadcast

All content is stripped before broadcast. This includes:

| Sensitive data | How it's handled |
|----------------|-----------------|
| File contents | Stripped entirely — only the basename is kept |
| Code (edits, writes) | Stripped — old/new strings never leave |
| Bash commands | Stripped — only the optional `description` field is used |
| Thinking text | Stripped — never included |
| Assistant responses | Stripped — never included |
| User prompts | Stripped — only the presence of a prompt is noted |
| Tool result output | Stripped — only success/error status is kept |
| Full file paths | Stripped to basename (`/Users/you/project/src/auth.ts` → `auth.ts`) |
| Full project paths | Stripped to last segment (`/Users/you/Projects/my-app` → `my-app`) |
| URLs (WebFetch) | Stripped entirely |
| Search queries (WebSearch) | Stripped entirely |
| Task prompts | Stripped — only the agent type (`explore`, `bash`) is kept |
| Todo content | Stripped — only the count (`"3 items"`) is kept |
| Error messages | Stripped — only the severity (`warning`/`error`) is kept |
| API keys, secrets | Never included — content fields are never broadcast |

### How stripping works

The pipeline has three stages:

```
JSONL file  →  Parser  →  Adapter  →  WebSocket
(raw data)    (parse)    (strip)     (broadcast)
```

1. **Parser** (`src/parser.ts`) — Reads raw JSONL, parses JSON, routes to the appropriate adapter based on source.
2. **Adapter** (`src/adapters/claude-code.ts`, `src/adapters/copilot-cli.ts`) — The privacy gate. Uses an explicit allowlist per tool to extract only safe fields. Unknown tools produce no context at all.
3. **Broadcast** (`src/websocket.ts`) — Sends the already-filtered events to connected clients. No additional data is added.

Privacy utilities (`toBasename`, `toProjectName` in `src/pixel-events.ts`) ensure paths are always stripped to their last segment.

### Test-verified

The test suite includes dedicated privacy tests that feed sensitive data (API keys, passwords, file paths, secrets) through the full pipeline and assert **none of it appears in broadcast output**:

```
tests/pipeline.test.ts            → Full pipeline privacy verification (Claude Code + Copilot CLI)
tests/claude-code-adapter.test.ts → Per-tool privacy audit (Claude Code)
tests/copilot-cli-adapter.test.ts → Per-tool privacy audit (Copilot CLI)
```

Run them yourself:

```bash
npm test
```

---

## How It Works

```
~/.claude/projects/**/*.jsonl          (Claude Code)
~/.copilot/session-state/*/events.jsonl (Copilot CLI)
        │
        ▼
   ┌─────────┐     ┌─────────┐     ┌───────────┐     ┌────────────┐
   │ Watcher  │────▶│ Parser  │────▶│  Adapter  │────▶│ WebSocket  │
   │(chokidar)│     │ (JSONL) │     │ (privacy) │     │ broadcast  │
   └─────────┘     └─────────┘     └───────────┘     └────────────┘
                                                            │
                                        ┌───────────┐      │
                                        │  Bonjour  │      │
                                        │  (mDNS)   │      │
                                        └───────────┘      │
                                                            ▼
                                                    iOS app (SpriteKit)
```

1. **Watch** — Monitors session files from all supported agents using chokidar
2. **Parse** — Parses each new line as JSON, routes to the correct adapter based on source
3. **Transform** — Adapter strips sensitive content, maps tools to categories, produces normalized events
4. **Broadcast** — Sends events over WebSocket to connected clients on the local network
5. **Discover** — Advertises via Bonjour/mDNS so the iOS app finds the server automatically
6. **Authenticate** — Devices must pair with a one-time 6-digit code to receive events. Tokens persist across restarts.

## Event Schema

Every WebSocket message has this envelope:

```json
{ "type": "event", "payload": { ...PixelEvent } }
```

### Session

```json
{
  "type": "session",
  "sessionId": "abc-123",
  "action": "started",
  "project": "my-app"
}
```

Actions: `started`, `ended`

### Activity

```json
{
  "type": "activity",
  "sessionId": "abc-123",
  "action": "thinking"
}
```

Actions: `thinking`, `responding`, `waiting`, `user_prompt`

### Tool

```json
{
  "type": "tool",
  "sessionId": "abc-123",
  "tool": "file_read",
  "detail": "read",
  "status": "started",
  "context": "auth.ts"
}
```

Tool categories: `file_read`, `file_write`, `terminal`, `search`, `plan`, `communicate`, `spawn_agent`, `notebook`, `other`

### Agent

```json
{
  "type": "agent",
  "sessionId": "abc-123",
  "action": "spawned",
  "agentRole": "explore"
}
```

Actions: `spawned`, `completed`, `error`

### Summary

```json
{
  "type": "summary",
  "sessionId": "abc-123"
}
```

Emitted at the end of a conversation turn. The iOS app uses this to immediately begin the idle/cooling transition (no wait for the full idle timer).

### Error

```json
{
  "type": "error",
  "sessionId": "abc-123",
  "severity": "error"
}
```

---

## Development

```bash
git clone https://github.com/waynedev9598/pixelhq-bridge.git
cd pixelhq-bridge
npm install
npm run dev        # Development with hot reload
npm test           # Run all tests
npm run test:watch # Watch mode
```

### Project Structure

```
pixelhq-bridge/
├── bin/
│   └── cli.ts                 # CLI entry point (npx pixelhq)
├── src/
│   ├── index.ts               # Bridge orchestrator
│   ├── config.ts              # Configuration + CLI args
│   ├── logger.ts              # Centralized logger (normal/verbose modes)
│   ├── watcher.ts             # File watcher (chokidar)
│   ├── parser.ts              # JSONL parsing + adapter routing
│   ├── adapters/
│   │   ├── claude-code.ts     # Claude Code privacy-stripping adapter
│   │   └── copilot-cli.ts     # Copilot CLI privacy-stripping adapter
│   ├── pixel-events.ts        # Event factories + privacy utils
│   ├── session.ts             # Session tracking + agent state
│   ├── auth.ts                # Device pairing + token auth
│   ├── websocket.ts           # WebSocket server (ws)
│   ├── bonjour.ts             # mDNS advertisement
│   ├── typed-emitter.ts       # Type-safe EventEmitter
│   └── types.ts               # Shared TypeScript types
└── tests/                     # vitest test suite
```

## Publishing

Releases are published to npm automatically via GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — every published version is cryptographically linked to the exact source commit that built it. No code is published from a local machine.

### One-time setup

1. **Create an npm account** at [npmjs.com](https://www.npmjs.com/signup) (if you don't have one)
2. **Generate an access token** — go to npmjs.com → Access Tokens → Generate New Token → select **Automation**
3. **Add the token to GitHub** — go to your repo → Settings → Secrets and variables → Actions → New repository secret → name it `NPM_TOKEN`, paste the token

### Releasing a new version

Bump the `version` in `package.json` and push to `main`. That's it.

```bash
npm version patch   # or minor / major
git push
```

CI detects the version change, runs tests, builds, and publishes to npm with provenance. If the version hasn't changed, CI skips the publish step.

Users can verify provenance on the [npm package page](https://www.npmjs.com/package/pixelhq) — it shows the exact commit, repo, and workflow that produced each version.

## License

MIT
