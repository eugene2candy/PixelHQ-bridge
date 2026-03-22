import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { ToolMapping } from './types.js';

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function findPackageJson(startDir: string): string {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find package.json');
    dir = parent;
  }
}

const pkg = JSON.parse(readFileSync(findPackageJson(__dirname), 'utf-8')) as {
  version: string;
};

// ---------------------------------------------------------------------------
// CLI argument helpers
// ---------------------------------------------------------------------------

function getCliArg(name: string): string | null {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1]! : null;
}

function hasCliFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Source directory resolution
// ---------------------------------------------------------------------------

export interface ResolvedSource {
  dir: string;
  watchDir: string;
  resolvedVia: string;
}

export function resolveClaudeDir(): ResolvedSource | null {
  const home = homedir();
  const candidates: { path: string | null | undefined; via: string }[] = [
    { path: getCliArg('claude-dir'), via: '--claude-dir flag' },
    { path: process.env.CLAUDE_CONFIG_DIR, via: 'CLAUDE_CONFIG_DIR env' },
    { path: join(home, '.claude'), via: 'default (~/.claude)' },
    { path: join(home, '.config', 'claude'), via: 'XDG (~/.config/claude)' },
  ];

  for (const { path, via } of candidates) {
    if (!path) continue;
    const projectsDir = join(path, 'projects');
    if (existsSync(projectsDir)) {
      return { dir: path, watchDir: projectsDir, resolvedVia: via };
    }
    if (existsSync(path)) {
      return { dir: path, watchDir: projectsDir, resolvedVia: `${via} (no projects/ yet)` };
    }
  }

  return null;
}

export function resolveCopilotDir(): ResolvedSource | null {
  const home = homedir();
  const candidates: { path: string | null | undefined; via: string }[] = [
    { path: getCliArg('copilot-dir'), via: '--copilot-dir flag' },
    { path: process.env.COPILOT_CONFIG_DIR, via: 'COPILOT_CONFIG_DIR env' },
    { path: join(home, '.copilot'), via: 'default (~/.copilot)' },
  ];

  for (const { path, via } of candidates) {
    if (!path) continue;
    const sessionStateDir = join(path, 'session-state');
    if (existsSync(sessionStateDir)) {
      return { dir: path, watchDir: sessionStateDir, resolvedVia: via };
    }
    if (existsSync(path)) {
      return { dir: path, watchDir: sessionStateDir, resolvedVia: `${via} (no session-state/ yet)` };
    }
  }

  return null;
}

// Resolve once at import time — null means not available
const resolvedClaude = resolveClaudeDir();
const resolvedCopilot = resolveCopilotDir();

if (!resolvedClaude && !resolvedCopilot) {
  throw new Error(
    'No supported AI coding agent found.\n\n' +
    'Looked for:\n' +
    '  - Claude Code at ~/.claude\n' +
    '  - GitHub Copilot CLI at ~/.copilot\n\n' +
    'Use --claude-dir or --copilot-dir to specify a directory manually.'
  );
}

const primaryDir = (resolvedClaude?.dir ?? resolvedCopilot?.dir)!;

// ---------------------------------------------------------------------------
// Bridge server configuration
// ---------------------------------------------------------------------------

export const config = {
  claude: resolvedClaude,
  copilot: resolvedCopilot,
  version: pkg.version,
  wsPort: Number(getCliArg('port') || process.env.PIXEL_OFFICE_PORT || 8765),
  bonjourName: 'Pixel Office Bridge',
  bonjourType: 'pixeloffice',
  watchDebounce: 100,
  sessionTtlMs: 2 * 60 * 1000,
  sessionReapIntervalMs: 30 * 1000,
  authTokenFile: join(primaryDir, 'pixel-office-auth.json'),
  verbose: hasCliFlag('verbose'),
  nonInteractive: hasCliFlag('yes') || hasCliFlag('y') || process.env.CI === 'true',
} as const;

// ---------------------------------------------------------------------------
// PixelEvent types
// ---------------------------------------------------------------------------

export const PixelEventType = {
  SESSION: 'session',
  ACTIVITY: 'activity',
  TOOL: 'tool',
  AGENT: 'agent',
  ERROR: 'error',
  SUMMARY: 'summary',
} as const;

// ---------------------------------------------------------------------------
// Tool category mapping
// ---------------------------------------------------------------------------

export const ToolCategory = {
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  TERMINAL: 'terminal',
  SEARCH: 'search',
  PLAN: 'plan',
  COMMUNICATE: 'communicate',
  SPAWN_AGENT: 'spawn_agent',
  NOTEBOOK: 'notebook',
  OTHER: 'other',
} as const;

export const TOOL_TO_CATEGORY: Record<string, ToolMapping> = {
  // Claude Code tools (PascalCase)
  Read:            { category: ToolCategory.FILE_READ,    detail: 'read' },
  Write:           { category: ToolCategory.FILE_WRITE,   detail: 'write' },
  Edit:            { category: ToolCategory.FILE_WRITE,   detail: 'edit' },
  Bash:            { category: ToolCategory.TERMINAL,     detail: 'bash' },
  Grep:            { category: ToolCategory.SEARCH,       detail: 'grep' },
  Glob:            { category: ToolCategory.SEARCH,       detail: 'glob' },
  WebFetch:        { category: ToolCategory.SEARCH,       detail: 'web_fetch' },
  WebSearch:       { category: ToolCategory.SEARCH,       detail: 'web_search' },
  Task:            { category: ToolCategory.SPAWN_AGENT,  detail: 'task' },
  TodoWrite:       { category: ToolCategory.PLAN,         detail: 'todo' },
  EnterPlanMode:   { category: ToolCategory.PLAN,         detail: 'enter_plan' },
  ExitPlanMode:    { category: ToolCategory.PLAN,         detail: 'exit_plan' },
  AskUserQuestion: { category: ToolCategory.COMMUNICATE,  detail: 'ask_user' },
  NotebookEdit:    { category: ToolCategory.NOTEBOOK,     detail: 'notebook' },

  // Copilot CLI tools (lowercase)
  view:            { category: ToolCategory.FILE_READ,    detail: 'read' },
  edit:            { category: ToolCategory.FILE_WRITE,   detail: 'edit' },
  create:          { category: ToolCategory.FILE_WRITE,   detail: 'write' },
  bash:            { category: ToolCategory.TERMINAL,     detail: 'bash' },
  read_bash:       { category: ToolCategory.TERMINAL,     detail: 'bash' },
  write_bash:      { category: ToolCategory.TERMINAL,     detail: 'bash' },
  stop_bash:       { category: ToolCategory.TERMINAL,     detail: 'bash' },
  list_bash:       { category: ToolCategory.TERMINAL,     detail: 'bash' },
  grep:            { category: ToolCategory.SEARCH,       detail: 'grep' },
  glob:            { category: ToolCategory.SEARCH,       detail: 'glob' },
  web_fetch:       { category: ToolCategory.SEARCH,       detail: 'web_fetch' },
  web_search:      { category: ToolCategory.SEARCH,       detail: 'web_search' },
  task:            { category: ToolCategory.SPAWN_AGENT,  detail: 'task' },
  sql:             { category: ToolCategory.PLAN,         detail: 'sql' },
  store_memory:    { category: ToolCategory.PLAN,         detail: 'memory' },
  ask_user:        { category: ToolCategory.COMMUNICATE,  detail: 'ask_user' },
};
