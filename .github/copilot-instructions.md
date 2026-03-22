# Copilot Instructions — pixelhq-bridge

## Commands

```bash
npm run build          # TypeScript → dist/
npm test               # Run all tests (vitest)
npm run test:watch     # Watch mode
npx vitest run tests/copilot-cli-adapter.test.ts  # Single test file
npm run dev            # Build + run with --watch
```

## Architecture

The bridge watches JSONL session files from AI coding agents and broadcasts privacy-stripped activity events over WebSocket to an iOS app.

**Pipeline:** `Watcher → Parser → Adapter → SessionManager → WebSocket → iOS app`

- **Watcher** (`src/watcher.ts`) — Uses chokidar to tail JSONL files. Detects source (Claude Code vs Copilot CLI) from file path. Reads `workspace.yaml` for Copilot project names.
- **Parser** (`src/parser.ts`) — Validates JSON, injects `_sessionId`/`_agentId`, routes to the correct adapter via the `source` parameter.
- **Adapters** (`src/adapters/`) — Transform raw JSONL into normalized `PixelEvent`s. Each adapter is a function `(RawJsonlEvent) => PixelEvent[]`. This is where all privacy stripping happens.
- **SessionManager** (`src/session.ts`) — Tracks session lifecycle, agent correlation (FIFO mapping of file agent IDs to tool-use IDs), and idle reaping.
- **Config** (`src/config.ts`) — Auto-detects agent directories, resolves CLI flags, and defines the `TOOL_TO_CATEGORY` mapping shared by all adapters.

**Multi-source design:** `config.claude` and `config.copilot` are both nullable `ResolvedSource | null`. The watcher builds watch patterns from whichever sources are available. The `source` string flows through `WatcherLineEvent → handleNewLine → transformToPixelEvents` to select the right adapter.

**Agent correlation:** Claude Code spawns sub-agents as separate JSONL files. The bridge uses a FIFO queue (`pendingSpawnQueue` ↔ `deferredAgentFiles`) to map file-based agent IDs to their parent `toolUseId`. Copilot CLI handles sub-agents inline via `subagent.started/completed` events.

## Key Conventions

**Privacy is the core constraint.** Adapters use an explicit allowlist approach — only specifically extracted fields are emitted. Unknown tools produce no context. Test suites include dedicated privacy audits that feed sensitive data through the pipeline and assert none appears in output.

**Event types are a closed set:** `session`, `activity`, `tool`, `agent`, `error`, `summary`. Tool categories are also fixed: `file_read`, `file_write`, `terminal`, `search`, `plan`, `communicate`, `spawn_agent`, `notebook`, `other`. The iOS app decodes these — changing them is a breaking change.

**Adding a new agent adapter:**
1. Create `src/adapters/<name>.ts` exporting a function matching `(RawJsonlEvent) => PixelEvent[]`
2. Register it in `src/parser.ts` in the `adapters` map
3. Add watch patterns in `src/watcher.ts` and path parsing in a `parse<Name>FilePath` method
4. Add tool name mappings to `TOOL_TO_CATEGORY` in `src/config.ts`
5. Add directory resolution in `config.ts` and wire it into the `config` object
6. Write adapter tests mirroring `tests/claude-code-adapter.test.ts` — include privacy audit and iOS decode contract tests

**Helper utilities for adapters:** `toBasename()` strips paths to filename only, `toProjectName()` strips to last segment. Event factories (`createActivityEvent`, `createToolEvent`, etc.) are in `src/pixel-events.ts`.

**ESM project** — Uses `"type": "module"` with `.js` extensions in imports. TypeScript targets ES2022 with Node16 module resolution.
