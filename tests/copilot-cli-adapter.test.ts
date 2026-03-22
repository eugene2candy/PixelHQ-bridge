import { describe, it, expect } from 'vitest';
import { copilotCliAdapter } from '../src/adapters/copilot-cli.js';
import type { RawJsonlEvent, PixelEvent } from '../src/types.js';

function makeCopilotRaw(
  type: string,
  data: Record<string, unknown>,
  overrides: Partial<RawJsonlEvent> = {},
): RawJsonlEvent {
  return {
    type,
    data,
    id: 'evt-' + Math.random().toString(36).slice(2, 10),
    timestamp: '2026-03-22T12:00:00Z',
    parentId: null,
    _sessionId: 'sess-copilot-1',
    _agentId: null,
    ...overrides,
  } as unknown as RawJsonlEvent;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('session events', () => {
  it('session.start → SessionEvent (started)', () => {
    const raw = makeCopilotRaw('session.start', {
      sessionId: 'sess-copilot-1',
      version: 1,
      producer: 'copilot-agent',
      copilotVersion: '1.0.10',
      startTime: '2026-03-22T12:00:00Z',
      context: {
        cwd: '/Users/dev/projects/my-app',
        gitRoot: '/Users/dev/projects/my-app',
        branch: 'main',
        repository: 'dev/my-app',
      },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);

    const e = events[0]!;
    expect(e.type).toBe('session');
    expect((e as { action: string }).action).toBe('started');
    expect((e as { project: string }).project).toBe('my-app');
    expect((e as { source: string }).source).toBe('copilot-cli');
  });

  it('session.start strips full path — only project name emitted', () => {
    const raw = makeCopilotRaw('session.start', {
      context: {
        cwd: '/Users/secret-user/Documents/private/secret-project',
      },
    });

    const events = copilotCliAdapter(raw);
    const json = JSON.stringify(events);
    expect(json).not.toContain('/Users/secret-user');
    expect(json).not.toContain('Documents');
    expect(json).toContain('secret-project');
  });

  it('session.shutdown emits token usage', () => {
    const raw = makeCopilotRaw('session.shutdown', {
      shutdownType: 'routine',
      modelMetrics: {
        'claude-sonnet-4': {
          requests: { count: 50, cost: 10 },
          usage: {
            inputTokens: 100000,
            outputTokens: 5000,
            cacheReadTokens: 80000,
          },
        },
      },
    });

    const events = copilotCliAdapter(raw);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const activity = events.find(e => e.type === 'activity');
    expect(activity).toBeDefined();
    const tokens = (activity as { tokens: { input: number; output: number; cacheRead?: number } }).tokens;
    expect(tokens.input).toBe(100000);
    expect(tokens.output).toBe(5000);
    expect(tokens.cacheRead).toBe(80000);
  });
});

// ---------------------------------------------------------------------------
// User messages
// ---------------------------------------------------------------------------

describe('user.message', () => {
  it('emits user_prompt activity', () => {
    const raw = makeCopilotRaw('user.message', {
      content: 'Fix the authentication bug',
      transformedContent: '<system>...</system>\n\nFix the authentication bug',
      attachments: [],
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect((events[0] as { action: string }).action).toBe('user_prompt');
  });

  it('does NOT leak user message content', () => {
    const raw = makeCopilotRaw('user.message', {
      content: 'My API key is sk-secret-12345',
      transformedContent: 'My API key is sk-secret-12345',
    });

    const events = copilotCliAdapter(raw);
    const json = JSON.stringify(events);
    expect(json).not.toContain('sk-secret-12345');
    expect(json).not.toContain('API key');
  });
});

// ---------------------------------------------------------------------------
// Assistant messages
// ---------------------------------------------------------------------------

describe('assistant messages', () => {
  it('assistant.turn_start → thinking activity', () => {
    const raw = makeCopilotRaw('assistant.turn_start', {
      turnId: '0',
      interactionId: 'int-1',
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect((events[0] as { action: string }).action).toBe('thinking');
  });

  it('assistant.message with content → responding activity', () => {
    const raw = makeCopilotRaw('assistant.message', {
      messageId: 'msg-1',
      content: 'I found the bug in the authentication module.',
      outputTokens: 150,
      interactionId: 'int-1',
    });

    const events = copilotCliAdapter(raw);
    const responding = events.find(e => e.type === 'activity' && (e as { action: string }).action === 'responding');
    expect(responding).toBeDefined();
    expect((responding as { tokens: { output: number } }).tokens?.output).toBe(150);
  });

  it('assistant.message does NOT leak response text', () => {
    const raw = makeCopilotRaw('assistant.message', {
      content: 'The password stored in config.yml is hunter2 and the API key is sk-abc123',
      outputTokens: 200,
    });

    const events = copilotCliAdapter(raw);
    const json = JSON.stringify(events);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('sk-abc123');
    expect(json).not.toContain('password');
    expect(json).not.toContain('config.yml');
  });

  it('assistant.message with ask_user tool → waiting activity', () => {
    const raw = makeCopilotRaw('assistant.message', {
      content: '',
      toolRequests: [
        {
          toolCallId: 'call-1',
          name: 'ask_user',
          arguments: { question: 'Which database should I use?' },
          type: 'function',
        },
      ],
    });

    const events = copilotCliAdapter(raw);
    const waiting = events.find(e => e.type === 'activity' && (e as { action: string }).action === 'waiting');
    expect(waiting).toBeDefined();
  });

  it('assistant.turn_end → summary event', () => {
    const raw = makeCopilotRaw('assistant.turn_end', { turnId: '0' });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('summary');
  });
});

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

describe('tool.execution_start', () => {
  it('view tool → file_read', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-view-1',
      toolName: 'view',
      arguments: { path: '/Users/dev/projects/my-app/src/auth.ts' },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');

    const tool = events[0] as { tool: string; context: string; status: string; toolUseId: string };
    expect(tool.tool).toBe('file_read');
    expect(tool.context).toBe('auth.ts');
    expect(tool.status).toBe('started');
    expect(tool.toolUseId).toBe('call-view-1');
  });

  it('edit tool → file_write with basename only', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-edit-1',
      toolName: 'edit',
      arguments: {
        path: '/Users/dev/projects/my-app/src/utils.ts',
        old_str: 'const SECRET = "hunter2"',
        new_str: 'const SECRET = process.env.SECRET',
      },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);

    const json = JSON.stringify(events);
    expect(json).toContain('utils.ts');
    expect(json).not.toContain('/Users/dev');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('SECRET');
  });

  it('create tool → file_write', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-create-1',
      toolName: 'create',
      arguments: {
        path: '/Users/dev/projects/my-app/src/new-file.ts',
        file_text: 'export const API_KEY = "sk-secret"',
      },
    });

    const events = copilotCliAdapter(raw);
    const json = JSON.stringify(events);
    expect(json).toContain('new-file.ts');
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('API_KEY');
  });

  it('bash tool → terminal with description only', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      arguments: {
        command: 'npm test --coverage && cat coverage/lcov.info',
        description: 'Run tests with coverage',
      },
    });

    const events = copilotCliAdapter(raw);
    const json = JSON.stringify(events);
    expect(json).toContain('Run tests with coverage');
    expect(json).not.toContain('npm test');
    expect(json).not.toContain('lcov.info');
  });

  it('grep tool → search with pattern', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-grep-1',
      toolName: 'grep',
      arguments: {
        pattern: 'handleAuth',
        path: '/Users/dev/projects/my-app/src',
      },
    });

    const events = copilotCliAdapter(raw);
    const json = JSON.stringify(events);
    expect(json).toContain('handleAuth');
    expect(json).not.toContain('/Users/dev');
  });

  it('glob tool → search with pattern', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-glob-1',
      toolName: 'glob',
      arguments: { pattern: '**/*.test.ts' },
    });

    const events = copilotCliAdapter(raw);
    expect((events[0] as { tool: string }).tool).toBe('search');
    expect((events[0] as { context: string }).context).toBe('**/*.test.ts');
  });

  it('task tool → spawn_agent + agent spawned', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-task-1',
      toolName: 'task',
      arguments: {
        name: 'explore-auth',
        agent_type: 'explore',
        prompt: 'Find all authentication logic in the codebase',
      },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(2);

    const toolEvt = events[0] as { tool: string; context: string };
    expect(toolEvt.tool).toBe('spawn_agent');
    expect(toolEvt.context).toBe('explore');

    const agentEvt = events[1] as { type: string; action: string; agentRole: string };
    expect(agentEvt.type).toBe('agent');
    expect(agentEvt.action).toBe('spawned');
    expect(agentEvt.agentRole).toBe('explore');

    // Privacy: prompt not leaked
    const json = JSON.stringify(events);
    expect(json).not.toContain('Find all authentication');
  });

  it('skips report_intent (internal tool)', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-ri-1',
      toolName: 'report_intent',
      arguments: { intent: 'Fixing auth bug' },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(0);
  });

  it('skips task_complete (internal tool)', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-tc-1',
      toolName: 'task_complete',
      arguments: { summary: 'Done fixing the bug' },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(0);
  });

  it('ask_user tool → communicate', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-ask-1',
      toolName: 'ask_user',
      arguments: {
        question: 'Should I use PostgreSQL or MySQL?',
        choices: ['PostgreSQL', 'MySQL'],
      },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect((events[0] as { tool: string }).tool).toBe('communicate');

    // Privacy: question not leaked
    const json = JSON.stringify(events);
    expect(json).not.toContain('PostgreSQL');
    expect(json).not.toContain('MySQL');
  });

  it('web_fetch tool → search without URL', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-wf-1',
      toolName: 'web_fetch',
      arguments: { url: 'https://secret-internal.company.com/api/docs' },
    });

    const events = copilotCliAdapter(raw);
    expect((events[0] as { tool: string }).tool).toBe('search');
    const json = JSON.stringify(events);
    expect(json).not.toContain('secret-internal');
    expect(json).not.toContain('company.com');
  });

  it('sql tool → plan without query content', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-sql-1',
      toolName: 'sql',
      arguments: {
        query: 'SELECT * FROM users WHERE password = "hunter2"',
        description: 'Query users',
      },
    });

    const events = copilotCliAdapter(raw);
    expect((events[0] as { tool: string }).tool).toBe('plan');
    const json = JSON.stringify(events);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('SELECT');
  });

  it('GitHub MCP tool → other with repo name only', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-gh-1',
      toolName: 'github-mcp-server-list_pull_requests',
      arguments: {
        owner: 'myorg',
        repo: 'my-repo',
        state: 'open',
      },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect((events[0] as { context: string }).context).toBe('my-repo');
  });

  it('unknown tool → other category', () => {
    const raw = makeCopilotRaw('tool.execution_start', {
      toolCallId: 'call-unknown',
      toolName: 'some_new_tool',
      arguments: { data: 'sensitive' },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect((events[0] as { tool: string }).tool).toBe('other');
    const json = JSON.stringify(events);
    expect(json).not.toContain('sensitive');
  });
});

// ---------------------------------------------------------------------------
// Tool completion
// ---------------------------------------------------------------------------

describe('tool.execution_complete', () => {
  it('successful completion', () => {
    const raw = makeCopilotRaw('tool.execution_complete', {
      toolCallId: 'call-view-1',
      model: 'claude-sonnet-4',
      success: true,
      result: { content: 'Full file contents here with secrets...' },
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect((events[0] as { status: string }).status).toBe('completed');

    // Privacy: result not leaked
    const json = JSON.stringify(events);
    expect(json).not.toContain('Full file contents');
    expect(json).not.toContain('secrets');
  });

  it('failed completion → error status', () => {
    const raw = makeCopilotRaw('tool.execution_complete', {
      toolCallId: 'call-bash-1',
      success: false,
      error: 'Command failed with exit code 1: npm test',
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect((events[0] as { status: string }).status).toBe('error');

    // Privacy: error message not leaked
    const json = JSON.stringify(events);
    expect(json).not.toContain('npm test');
    expect(json).not.toContain('Command failed');
  });
});

// ---------------------------------------------------------------------------
// Sub-agent lifecycle
// ---------------------------------------------------------------------------

describe('subagent events', () => {
  it('subagent.started → agent spawned', () => {
    const raw = makeCopilotRaw('subagent.started', {
      toolCallId: 'call-task-1',
      agentName: 'explore',
      agentDisplayName: 'Explore Agent',
      agentDescription: 'Fast codebase exploration...',
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('agent');
    expect((events[0] as { action: string }).action).toBe('spawned');
    expect((events[0] as { agentRole: string }).agentRole).toBe('explore');

    // Privacy: description not leaked
    const json = JSON.stringify(events);
    expect(json).not.toContain('Fast codebase');
  });

  it('subagent.completed → agent completed', () => {
    const raw = makeCopilotRaw('subagent.completed', {
      toolCallId: 'call-task-1',
      agentName: 'explore',
      agentDisplayName: 'Explore Agent',
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('agent');
    expect((events[0] as { action: string }).action).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Special events
// ---------------------------------------------------------------------------

describe('special events', () => {
  it('session.task_complete → summary', () => {
    const raw = makeCopilotRaw('session.task_complete', {
      summary: 'Completed the authentication fix with full test coverage',
      success: true,
    });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('summary');

    // Privacy: summary text not leaked
    const json = JSON.stringify(events);
    expect(json).not.toContain('authentication');
  });

  it('abort → summary', () => {
    const raw = makeCopilotRaw('abort', { reason: 'user initiated' });

    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('summary');
  });
});

// ---------------------------------------------------------------------------
// Ignored events
// ---------------------------------------------------------------------------

describe('ignored events', () => {
  it.each([
    'session.info',
    'session.mode_changed',
    'session.plan_changed',
    'hook.start',
    'hook.end',
    'system.notification',
    'skill.invoked',
  ])('%s → no events', (type) => {
    const raw = makeCopilotRaw(type, { someData: 'value' });
    const events = copilotCliAdapter(raw);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Privacy audit
// ---------------------------------------------------------------------------

describe('comprehensive privacy audit', () => {
  it('never leaks sensitive data across all event types', () => {
    const sensitiveData = [
      'sk-abc123-secret-key',
      'password123',
      '/Users/dev/secret/path',
      'SELECT * FROM passwords',
      'curl https://internal.company.com',
      'Bearer token-xyz-789',
    ];

    const events: PixelEvent[] = [];

    // Feed various event types with sensitive data embedded
    const rawEvents = [
      makeCopilotRaw('user.message', {
        content: `My API key is ${sensitiveData[0]} and password is ${sensitiveData[1]}`,
      }),
      makeCopilotRaw('assistant.message', {
        content: `I found your key at ${sensitiveData[2]}: ${sensitiveData[0]}`,
        outputTokens: 100,
      }),
      makeCopilotRaw('tool.execution_start', {
        toolCallId: 'c1', toolName: 'bash',
        arguments: { command: sensitiveData[4], description: 'Network call' },
      }),
      makeCopilotRaw('tool.execution_start', {
        toolCallId: 'c2', toolName: 'edit',
        arguments: {
          path: `${sensitiveData[2]}/config.ts`,
          old_str: `const KEY = "${sensitiveData[0]}"`,
          new_str: 'const KEY = process.env.KEY',
        },
      }),
      makeCopilotRaw('tool.execution_complete', {
        toolCallId: 'c1', success: true,
        result: { content: `${sensitiveData[3]} -- ${sensitiveData[5]}` },
      }),
      makeCopilotRaw('session.task_complete', {
        summary: `Fixed ${sensitiveData[1]} in ${sensitiveData[2]}`,
      }),
    ];

    for (const raw of rawEvents) {
      events.push(...copilotCliAdapter(raw));
    }

    const allJson = JSON.stringify(events);
    for (const sensitive of sensitiveData) {
      expect(allJson).not.toContain(sensitive);
    }
  });
});

// ---------------------------------------------------------------------------
// iOS decode contract
// ---------------------------------------------------------------------------

describe('iOS decode contract', () => {
  function assertDecodable(event: PixelEvent): void {
    expect(typeof event.id).toBe('string');
    expect(event.id.length).toBeGreaterThan(0);
    expect(typeof event.type).toBe('string');
    expect(['session', 'activity', 'tool', 'agent', 'error', 'summary']).toContain(event.type);
    expect(typeof event.sessionId).toBe('string');
    expect(typeof event.timestamp).toBe('string');

    const e = event as Record<string, unknown>;
    for (const field of ['agentId', 'action', 'project', 'model', 'source', 'detail', 'toolUseId', 'context', 'agentRole']) {
      if (field in e) {
        expect(typeof e[field]).toBe('string');
      }
    }

    if ('tool' in e && e.tool) {
      expect(['file_read', 'file_write', 'terminal', 'search', 'plan', 'communicate', 'spawn_agent', 'notebook', 'other']).toContain(e.tool);
    }
    if ('status' in e && e.status) {
      expect(['started', 'completed', 'error']).toContain(e.status);
    }
    if ('tokens' in e && e.tokens) {
      const tokens = e.tokens as Record<string, unknown>;
      expect(typeof tokens.input).toBe('number');
      expect(typeof tokens.output).toBe('number');
    }
  }

  it('all Copilot CLI events are iOS-decodable', () => {
    const rawEvents = [
      makeCopilotRaw('session.start', { context: { cwd: '/a/b' } }),
      makeCopilotRaw('user.message', { content: 'hi' }),
      makeCopilotRaw('assistant.turn_start', { turnId: '0' }),
      makeCopilotRaw('assistant.message', { content: 'hello', outputTokens: 50 }),
      makeCopilotRaw('tool.execution_start', { toolCallId: 'c1', toolName: 'view', arguments: { path: '/a/b.ts' } }),
      makeCopilotRaw('tool.execution_start', { toolCallId: 'c2', toolName: 'edit', arguments: { path: '/a/c.ts' } }),
      makeCopilotRaw('tool.execution_start', { toolCallId: 'c3', toolName: 'bash', arguments: { command: 'ls', description: 'List files' } }),
      makeCopilotRaw('tool.execution_start', { toolCallId: 'c4', toolName: 'grep', arguments: { pattern: 'TODO' } }),
      makeCopilotRaw('tool.execution_start', { toolCallId: 'c5', toolName: 'glob', arguments: { pattern: '*.ts' } }),
      makeCopilotRaw('tool.execution_start', { toolCallId: 'c6', toolName: 'task', arguments: { agent_type: 'explore', name: 'test' } }),
      makeCopilotRaw('tool.execution_start', { toolCallId: 'c7', toolName: 'ask_user', arguments: { question: 'q?' } }),
      makeCopilotRaw('tool.execution_complete', { toolCallId: 'c1', success: true }),
      makeCopilotRaw('tool.execution_complete', { toolCallId: 'c2', success: false }),
      makeCopilotRaw('subagent.started', { toolCallId: 'c6', agentName: 'explore' }),
      makeCopilotRaw('subagent.completed', { toolCallId: 'c6', agentName: 'explore' }),
      makeCopilotRaw('assistant.turn_end', { turnId: '0' }),
      makeCopilotRaw('session.task_complete', { summary: 'done', success: true }),
      makeCopilotRaw('abort', { reason: 'user initiated' }),
    ];

    const allEvents: PixelEvent[] = [];
    for (const raw of rawEvents) {
      allEvents.push(...copilotCliAdapter(raw));
    }

    expect(allEvents.length).toBeGreaterThan(0);
    for (const event of allEvents) {
      assertDecodable(event);
    }
  });
});
