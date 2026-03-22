import {
  createSessionEvent,
  createActivityEvent,
  createToolEvent,
  createAgentEvent,
  createSummaryEvent,
  toBasename,
  toProjectName,
} from '../pixel-events.js';
import { TOOL_TO_CATEGORY, ToolCategory } from '../config.js';
import type { PixelEvent, RawJsonlEvent, TokenUsage } from '../types.js';

// ---------------------------------------------------------------------------
// Copilot CLI raw event shape (internal — cast from RawJsonlEvent)
// ---------------------------------------------------------------------------

interface CopilotEvent {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId: string | null;
  _sessionId: string;
  _agentId: string | null;
}

/**
 * Transform a raw Copilot CLI JSONL event into PixelEvent(s).
 * Privacy-safe: strips all text content, full paths, commands, URLs, and queries.
 */
export function copilotCliAdapter(raw: RawJsonlEvent): PixelEvent[] {
  const event = raw as unknown as CopilotEvent;
  const sessionId = event._sessionId;
  const agentId = event._agentId || null;
  const timestamp = event.timestamp || new Date().toISOString();

  switch (event.type) {
    case 'session.start':
      return handleSessionStart(event, sessionId, timestamp);

    case 'session.shutdown':
      return handleSessionShutdown(event, sessionId, timestamp);

    case 'user.message':
      return [createActivityEvent(sessionId, agentId, timestamp, 'user_prompt')];

    case 'assistant.turn_start':
      return [createActivityEvent(sessionId, agentId, timestamp, 'thinking')];

    case 'assistant.message':
      return handleAssistantMessage(event, sessionId, agentId, timestamp);

    case 'assistant.turn_end':
      return [createSummaryEvent(sessionId, timestamp)];

    case 'tool.execution_start':
      return handleToolStart(event, sessionId, agentId, timestamp);

    case 'tool.execution_complete':
      return handleToolComplete(event, sessionId, agentId, timestamp);

    case 'subagent.started':
      return handleSubagentStarted(event, sessionId, timestamp);

    case 'subagent.completed':
      return handleSubagentCompleted(event, sessionId, timestamp);

    case 'session.task_complete':
      return [createSummaryEvent(sessionId, timestamp)];

    case 'abort':
      return [createSummaryEvent(sessionId, timestamp)];

    // Ignore internal/housekeeping events
    case 'session.info':
    case 'session.mode_changed':
    case 'session.plan_changed':
    case 'hook.start':
    case 'hook.end':
    case 'system.notification':
    case 'skill.invoked':
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleSessionStart(
  event: CopilotEvent,
  sessionId: string,
  timestamp: string,
): PixelEvent[] {
  const data = event.data;
  const context = data.context as Record<string, unknown> | undefined;

  const project = toProjectName(
    context?.cwd as string || context?.gitRoot as string,
  ) || sessionId.slice(0, 8);

  const model = undefined; // not available at session start
  const source = 'copilot-cli';

  return [createSessionEvent(sessionId, 'started', { project, model, source })];
}

function handleSessionShutdown(
  event: CopilotEvent,
  sessionId: string,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const data = event.data;

  // Extract token usage from model metrics
  const modelMetrics = data.modelMetrics as Record<string, Record<string, unknown>> | undefined;
  if (modelMetrics) {
    for (const metrics of Object.values(modelMetrics)) {
      const usage = metrics.usage as Record<string, number> | undefined;
      if (usage) {
        const tokens: TokenUsage = {
          input: usage.inputTokens || 0,
          output: usage.outputTokens || 0,
        };
        if (usage.cacheReadTokens) tokens.cacheRead = usage.cacheReadTokens;
        events.push(createActivityEvent(sessionId, null, timestamp, 'responding', tokens));
        break; // only report first model's tokens
      }
    }
  }

  return events;
}

function handleAssistantMessage(
  event: CopilotEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const data = event.data;
  const content = data.content as string | undefined;
  const outputTokens = data.outputTokens as number | undefined;

  if (content && content.length > 0) {
    const tokens: TokenUsage | null = outputTokens
      ? { input: 0, output: outputTokens }
      : null;
    events.push(createActivityEvent(sessionId, agentId, timestamp, 'responding', tokens));
  }

  // Tool requests trigger 'waiting' for ask_user
  const toolRequests = data.toolRequests as Array<Record<string, unknown>> | undefined;
  if (toolRequests) {
    for (const req of toolRequests) {
      if (req.name === 'ask_user') {
        events.push(createActivityEvent(sessionId, agentId, timestamp, 'waiting'));
      }
    }
  }

  return events;
}

function handleToolStart(
  event: CopilotEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const data = event.data;
  const toolName = data.toolName as string;
  const toolCallId = data.toolCallId as string;
  const args = data.arguments as Record<string, unknown> | null;

  // Skip internal-only tools
  if (toolName === 'report_intent' || toolName === 'task_complete' || toolName === 'list_bash') {
    return [];
  }

  const mapping = TOOL_TO_CATEGORY[toolName] || {
    category: ToolCategory.OTHER,
    detail: toolName,
  };

  const events: PixelEvent[] = [
    createToolEvent(sessionId, agentId, timestamp, {
      tool: mapping.category,
      detail: mapping.detail,
      status: 'started',
      toolUseId: toolCallId,
      context: extractSafeContext(toolName, args),
    }),
  ];

  // Spawning a sub-agent
  if (toolName === 'task') {
    events.push(
      createAgentEvent(
        sessionId,
        toolCallId,
        timestamp,
        'spawned',
        (args?.agent_type as string) || 'general',
      ),
    );
  }

  return events;
}

function handleToolComplete(
  event: CopilotEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const data = event.data;
  const toolCallId = data.toolCallId as string;
  const success = data.success as boolean;

  // Skip completions for internal tools we didn't emit starts for
  const toolName = findToolNameFromParent(event);
  if (toolName === 'report_intent' || toolName === 'task_complete' || toolName === 'list_bash') {
    return [];
  }

  return [
    createToolEvent(sessionId, agentId, timestamp, {
      tool: ToolCategory.OTHER,
      status: success ? 'completed' : 'error',
      toolUseId: toolCallId,
    }),
  ];
}

function handleSubagentStarted(
  event: CopilotEvent,
  sessionId: string,
  timestamp: string,
): PixelEvent[] {
  const data = event.data;
  const toolCallId = data.toolCallId as string;
  const agentName = data.agentName as string || 'general';

  return [
    createAgentEvent(sessionId, toolCallId, timestamp, 'spawned', agentName),
  ];
}

function handleSubagentCompleted(
  event: CopilotEvent,
  sessionId: string,
  timestamp: string,
): PixelEvent[] {
  const data = event.data;
  const toolCallId = data.toolCallId as string;

  return [
    createAgentEvent(sessionId, toolCallId, timestamp, 'completed'),
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSafeContext(toolName: string, args: Record<string, unknown> | null): string | null {
  if (!args) return null;

  switch (toolName) {
    case 'view':
    case 'edit':
    case 'create':
      return toBasename(args.path as string);

    case 'bash':
      return (args.description as string) || null;

    case 'grep':
      return (args.pattern as string) || null;

    case 'glob':
      return (args.pattern as string) || null;

    case 'task':
      return (args.agent_type as string) || (args.name as string) || null;

    case 'read_bash':
    case 'write_bash':
    case 'stop_bash':
      return null;

    // Privacy: strip URLs, queries, SQL, etc.
    case 'web_fetch':
    case 'web_search':
    case 'sql':
    case 'store_memory':
    case 'ask_user':
      return null;

    default:
      // GitHub MCP tools — extract safe context where possible
      if (toolName.startsWith('github-mcp-server-')) {
        return (args.repo as string) || null;
      }
      return null;
  }
}

/**
 * Try to identify the tool name from a tool.execution_complete event.
 * The toolCallId can be matched, but we don't have state here.
 * Instead, check if the data contains tool-identifying fields.
 */
function findToolNameFromParent(event: CopilotEvent): string | null {
  // Some completion events carry the model field but not toolName.
  // We can't reliably identify the tool without cross-event state,
  // so we return null and let the caller handle gracefully.
  return null;
}
