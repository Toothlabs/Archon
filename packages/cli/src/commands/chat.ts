/**
 * CLI chat command — send a message to the orchestrator agent
 *
 * Single-shot: streams response to stdout and exits.
 * Multi-turn conversations happen via the web UI.
 */
import { CLIAdapter } from '../adapters/cli-adapter';
import { handleMessage } from '@archon/core';
import { resolveCliUserRecordId } from './auth';

/**
 * Execute a single-shot orchestrator chat message.
 * Creates a unique conversation, streams the response to stdout, and returns.
 */
export async function chatCommand(message: string): Promise<void> {
  const adapter = new CLIAdapter({ streamingMode: 'batch' });
  const conversationId = `cli-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Attribute the conversation row to the local operator (ARCHON_USER_ID, else
  // $USER/$USERNAME). Undefined on an install with no resolvable CLI identity,
  // which keeps solo behavior unchanged; on an install that enforces conversation
  // ownership (#3135) an ownerless `cli` row would be reachable by nobody.
  const userId = await resolveCliUserRecordId();

  await handleMessage(adapter, conversationId, message, { userId });
}
