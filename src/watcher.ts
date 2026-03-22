import { watch, type FSWatcher } from 'chokidar';
import { createReadStream, statSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { join, basename, dirname } from 'path';
import { TypedEmitter } from './typed-emitter.js';
import { config } from './config.js';
import { logger } from './logger.js';
import type { WatcherSessionEvent, WatcherLineEvent, ParsedFilePath } from './types.js';

interface WatcherEvents {
  session: [WatcherSessionEvent];
  line: [WatcherLineEvent];
  error: [Error];
}

/**
 * Watches session JSONL files from multiple AI coding agents.
 * Emits 'line' events for each new JSONL line.
 */
export class SessionWatcher extends TypedEmitter<WatcherEvents> {
  private watcher: FSWatcher | null;
  private filePositions: Map<string, number>;
  private trackedSessions: Set<string>;
  private copilotProjectCache: Map<string, string>;

  constructor() {
    super();
    this.watcher = null;
    this.filePositions = new Map();
    this.trackedSessions = new Set();
    this.copilotProjectCache = new Map();
  }

  start(): void {
    const watchPatterns: string[] = [];

    if (config.claude) {
      watchPatterns.push(
        join(config.claude.watchDir, '*', '*.jsonl'),
        join(config.claude.watchDir, '*', '*', 'subagents', '*.jsonl'),
      );
    }

    if (config.copilot) {
      watchPatterns.push(
        join(config.copilot.watchDir, '*', 'events.jsonl'),
      );
    }

    if (watchPatterns.length === 0) {
      logger.error('Watcher', 'No watch patterns configured');
      return;
    }

    logger.verbose('Watcher', 'Starting file watcher...');

    this.watcher = watch(watchPatterns, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: config.watchDebounce,
        pollInterval: 50,
      },
      usePolling: false,
    });

    this.watcher
      .on('add', (filePath: string) => this.handleFileAdd(filePath))
      .on('change', (filePath: string) => this.handleFileChange(filePath))
      .on('error', (error: Error) => this.emit('error', error));

    logger.verbose('Watcher', 'File watcher started');
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.verbose('Watcher', 'File watcher stopped');
    }
  }

  handleFileAdd(filePath: string): void {
    try {
      const stats = statSync(filePath);
      const now = Date.now();
      const modifiedAgo = now - stats.mtimeMs;

      const recencyThreshold = 10 * 60 * 1000;

      if (modifiedAgo > recencyThreshold) {
        this.filePositions.set(filePath, stats.size);
        return;
      }

      const { sessionId, agentId, project, source } = this.parseFilePath(filePath);
      const minutesAgo = Math.round(modifiedAgo / 60000);

      logger.verbose('Watcher', `Tracking recent ${source} session: ${sessionId.slice(0, 8)}... (${minutesAgo}m ago)`);

      this.filePositions.set(filePath, stats.size);
      this.trackedSessions.add(sessionId);

      this.emit('session', {
        sessionId,
        agentId,
        project,
        filePath,
        action: 'discovered',
        source,
      });
    } catch (err) {
      logger.error('Watcher', `Error reading file stats: ${(err as Error).message}`);
    }
  }

  async handleFileChange(filePath: string): Promise<void> {
    const { sessionId, agentId, source } = this.parseFilePath(filePath);
    const previousPosition = this.filePositions.get(filePath) || 0;

    try {
      const stats = statSync(filePath);
      const currentSize = stats.size;

      if (currentSize <= previousPosition) {
        return;
      }

      if (!this.trackedSessions.has(sessionId)) {
        const { project } = this.parseFilePath(filePath);
        logger.verbose('Watcher', `Session became active: ${sessionId.slice(0, 8)}...`);
        this.trackedSessions.add(sessionId);

        this.emit('session', {
          sessionId,
          agentId,
          project,
          filePath,
          action: 'discovered',
          source,
        });
      }

      const newLines = await this.readNewLines(filePath, previousPosition);
      this.filePositions.set(filePath, currentSize);

      for (const line of newLines) {
        if (line.trim()) {
          this.emit('line', {
            line,
            sessionId,
            agentId,
            filePath,
            source,
          });
        }
      }
    } catch (err) {
      logger.error('Watcher', `Error reading file changes: ${(err as Error).message}`);
    }
  }

  readNewLines(filePath: string, startPosition: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const stream = createReadStream(filePath, {
        start: startPosition,
        encoding: 'utf8',
      });

      const rl = createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      rl.on('line', (line: string) => lines.push(line));
      rl.on('close', () => resolve(lines));
      rl.on('error', reject);
    });
  }

  parseFilePath(filePath: string): ParsedFilePath {
    // Detect source from file path
    if (config.copilot && filePath.startsWith(config.copilot.watchDir)) {
      return this.parseCopilotFilePath(filePath);
    }

    return this.parseClaudeFilePath(filePath);
  }

  private parseClaudeFilePath(filePath: string): ParsedFilePath {
    const fileName = basename(filePath, '.jsonl');
    const dirPath = dirname(filePath);

    const isSubagent = dirPath.includes('/subagents');

    let sessionId: string;
    let agentId: string | null = null;
    let project: string;

    if (isSubagent) {
      agentId = fileName;
      const subagentsDir = dirname(dirPath);
      sessionId = basename(subagentsDir);
      project = basename(dirname(subagentsDir));
    } else {
      sessionId = fileName;
      project = basename(dirPath);
    }

    const projectPath = project.replace(/^-/, '/').replace(/-/g, '/');

    return {
      sessionId,
      agentId,
      project: projectPath,
      source: 'claude-code',
    };
  }

  private parseCopilotFilePath(filePath: string): ParsedFilePath {
    // ~/.copilot/session-state/<session-id>/events.jsonl
    const sessionDir = dirname(filePath);
    const sessionId = basename(sessionDir);
    const project = this.resolveCopilotProject(sessionDir, sessionId);

    return {
      sessionId,
      agentId: null,
      project,
      source: 'copilot-cli',
    };
  }

  private resolveCopilotProject(sessionDir: string, sessionId: string): string {
    if (this.copilotProjectCache.has(sessionId)) {
      return this.copilotProjectCache.get(sessionId)!;
    }

    try {
      const workspaceFile = join(sessionDir, 'workspace.yaml');
      const content = readFileSync(workspaceFile, 'utf-8');
      const project = this.parseProjectFromWorkspaceYaml(content);
      if (project) {
        this.copilotProjectCache.set(sessionId, project);
        return project;
      }
    } catch {
      // workspace.yaml may not exist yet
    }

    return sessionId.slice(0, 8);
  }

  private parseProjectFromWorkspaceYaml(content: string): string | null {
    for (const line of content.split('\n')) {
      // Try cwd first (most descriptive), then git_root
      const match = line.match(/^(?:cwd|git_root):\s*(.+)$/);
      if (match) {
        const fullPath = match[1]!.trim();
        const parts = fullPath.split('/');
        return parts[parts.length - 1] || null;
      }
    }
    return null;
  }
}
