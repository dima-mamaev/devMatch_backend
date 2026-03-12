import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { ASSISTANT_INSTRUCTIONS } from './assistant-config';
import { TOOL_DEFINITIONS } from './tools/tool-definitions';
import { ToolHandlers } from './tools/tool-handlers';
import { EventPublisherService } from '../events/event-publisher.service';
import { AIMatchEventType, createEvent } from '../../../../libs/shared/src/types/event.types';

@Injectable()
export class OpenAIAgentService implements OnModuleInit {
  private readonly logger = new Logger(OpenAIAgentService.name);
  private openai: OpenAI;
  private assistantId: string;
  private cancelledMessages = new Set<string>();

  constructor(
    private configService: ConfigService,
    private toolHandlers: ToolHandlers,
    private eventPublisher: EventPublisherService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get('OPENAI_API_KEY'),
    });
  }

  async onModuleInit() {
    const apiKey = this.configService.get('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY not set. AI Agent will not be functional until configured.',
      );
      return;
    }
    await this.initializeAssistant();
  }

  private async initializeAssistant() {
    const existingAssistantId = this.configService.get('OPENAI_ASSISTANT_ID');

    try {
      if (existingAssistantId) {
        this.assistantId = existingAssistantId;
        await this.openai.beta.assistants.update(this.assistantId, {
          instructions: ASSISTANT_INSTRUCTIONS,
          tools: TOOL_DEFINITIONS,
          model: 'gpt-4o',
          response_format: { type: 'json_object' },
        });
        this.logger.log(`Updated existing assistant: ${this.assistantId}`);
      } else {
        const assistant = await this.openai.beta.assistants.create({
          name: 'DevMatch Recruiter Assistant',
          instructions: ASSISTANT_INSTRUCTIONS,
          tools: TOOL_DEFINITIONS,
          model: 'gpt-4o',
          response_format: { type: 'json_object' },
        });
        this.assistantId = assistant.id;
        this.logger.log(`Created new assistant: ${this.assistantId}`);
        this.logger.warn(
          `Save this assistant ID to OPENAI_ASSISTANT_ID env var: ${this.assistantId}`,
        );
      }
    } catch (error) {
      this.logger.error('Failed to initialize OpenAI assistant:', error);
      throw new Error(
        'OpenAI assistant initialization failed. Check OPENAI_API_KEY and permissions.',
      );
    }
  }

  async getOrCreateThread(existingThreadId?: string): Promise<string> {
    if (existingThreadId) {
      return existingThreadId;
    }
    const thread = await this.openai.beta.threads.create();
    return thread.id;
  }

  async runMatchingAgentStreaming(
    sessionId: string,
    messageId: string,
    prompt: string,
    threadId: string,
    excludeDeveloperIds?: string[],
    maxResults?: number,
  ): Promise<void> {
    if (!this.assistantId) {
      await this.emitEvent(sessionId, messageId, AIMatchEventType.ERROR, {
        errorMessage:
          'AI Agent is not configured. Please set OPENAI_API_KEY in environment variables.',
      });
      return;
    }

    await this.emitEvent(sessionId, messageId, AIMatchEventType.THINKING, {
      message: 'Analyzing your request...',
    });

    await this.openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: this.buildUserPrompt(prompt, excludeDeveloperIds, maxResults),
    });

    const stream = this.openai.beta.threads.runs.stream(threadId, {
      assistant_id: this.assistantId,
    });

    stream.on('run', async (run) => {
      await this.eventPublisher.publishRunStarted(sessionId, run.id);
    });

    try {
      for await (const event of stream) {
        if (this.isCancelled(messageId)) {
          this.logger.log(`Message ${messageId} cancelled, breaking stream loop`);
          await this.emitEvent(sessionId, messageId, AIMatchEventType.CANCELLED, {});
          this.clearCancellation(messageId);
          break;
        }
        await this.handleStreamEvent(sessionId, messageId, threadId, event);
      }
    } catch (streamError) {
      this.logger.error('Stream error:', streamError);
      if (!this.isCancelled(messageId)) {
        await this.emitEvent(sessionId, messageId, AIMatchEventType.ERROR, {
          errorMessage:
            streamError instanceof Error
              ? streamError.message
              : 'Stream interrupted',
        });
      }
      this.clearCancellation(messageId);
    }
  }

  private async handleStreamEvent(
    sessionId: string,
    messageId: string,
    threadId: string,
    event: OpenAI.Beta.Assistants.AssistantStreamEvent,
  ): Promise<void> {
    try {
      switch (event.event) {
        case 'thread.run.requires_action':
          await this.handleToolCallsStreaming(
            sessionId,
            messageId,
            threadId,
            event.data,
          );
          break;

        case 'thread.run.completed':
          await this.handleRunCompleted(sessionId, messageId, threadId);
          break;

        case 'thread.run.failed':
          await this.emitEvent(sessionId, messageId, AIMatchEventType.ERROR, {
            errorMessage: event.data.last_error?.message || 'Run failed',
          });
          break;

        case 'thread.run.cancelled':
          await this.emitEvent(
            sessionId,
            messageId,
            AIMatchEventType.CANCELLED,
            {
              reason: 'run_cancelled',
            },
          );
          break;
      }
    } catch (eventError) {
      this.logger.error(`Error handling event ${event.event}:`, eventError);
    }
  }

  private async handleToolCallsStreaming(
    sessionId: string,
    messageId: string,
    threadId: string,
    run: OpenAI.Beta.Threads.Runs.Run,
  ): Promise<void> {
    const toolCalls = run.required_action?.submit_tool_outputs?.tool_calls;
    if (!toolCalls) return;

    // Check cancellation before executing tools
    if (this.isCancelled(messageId)) {
      this.logger.log(`Message ${messageId} cancelled, skipping tool execution`);
      return;
    }

    const toolOutputs = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        // Skip if cancelled mid-processing
        if (this.isCancelled(messageId)) {
          return {
            tool_call_id: toolCall.id,
            output: JSON.stringify({ cancelled: true }),
          };
        }

        await this.emitEvent(sessionId, messageId, AIMatchEventType.TOOL_CALL, {
          toolName,
          toolArgs: args,
        });

        const result = await this.toolHandlers.execute(toolName, args);

        if (!this.isCancelled(messageId)) {
          await this.emitEvent(
            sessionId,
            messageId,
            AIMatchEventType.TOOL_RESULT,
            {
              toolName,
              resultSummary: this.summarizeToolResult(toolName, result),
              candidateCount: Array.isArray(result) ? result.length : undefined,
            },
          );
        }

        return {
          tool_call_id: toolCall.id,
          output: JSON.stringify(result),
        };
      }),
    );

    // Don't submit outputs or continue if cancelled
    if (this.isCancelled(messageId)) {
      this.logger.log(`Message ${messageId} cancelled, not submitting tool outputs`);
      return;
    }

    const continueStream = this.openai.beta.threads.runs.submitToolOutputsStream(
      run.id,
      {
        thread_id: threadId,
        tool_outputs: toolOutputs,
      },
    );

    for await (const event of continueStream) {
      if (this.isCancelled(messageId)) {
        this.logger.log(`Message ${messageId} cancelled, breaking continue stream`);
        break;
      }
      await this.handleStreamEvent(sessionId, messageId, threadId, event);
    }
  }

  private async handleRunCompleted(
    sessionId: string,
    messageId: string,
    threadId: string,
  ): Promise<void> {
    const messages = await this.openai.beta.threads.messages.list(threadId, {
      order: 'desc',
      limit: 1,
    });

    const lastMessage = messages.data[0];
    const content = lastMessage.content[0];

    if (content.type === 'text') {
      const rawText = content.text.value;
      this.logger.debug(`Raw assistant response: ${rawText}`);

      try {
        const jsonText = this.extractJsonFromMarkdown(rawText);
        const response = JSON.parse(jsonText);

        if (this.isCancelled(messageId)) {
          this.logger.log(`Message ${messageId} was cancelled, skipping match emission`);
          this.clearCancellation(messageId);
          return;
        }

        for (const match of response.matches || []) {
          if (this.isCancelled(messageId)) {
            this.logger.log(`Message ${messageId} cancelled mid-processing`);
            this.clearCancellation(messageId);
            return;
          }

          const developerProfile = await this.toolHandlers.execute(
            'get_developer_details',
            { developerId: match.developerId },
          );

          await this.emitEvent(
            sessionId,
            messageId,
            AIMatchEventType.MATCH_FOUND,
            {
              match: {
                ...match,
                developer: developerProfile,
              },
            },
          );
        }

        if (this.isCancelled(messageId)) {
          this.clearCancellation(messageId);
          return;
        }

        await this.emitEvent(sessionId, messageId, AIMatchEventType.COMPLETE, {
          summary: response.searchSummary,
          totalMatches: response.matches?.length || 0,
          totalCandidates: response.totalCandidates || 0,
          isOffTopic: response.isOffTopic || false,
        });
      } catch (parseError) {
        this.logger.error('Failed to parse agent response:', parseError);
        await this.emitEvent(sessionId, messageId, AIMatchEventType.COMPLETE, {
          summary: rawText.slice(0, 500), // Truncate if too long
          totalMatches: 0,
          totalCandidates: 0,
          isOffTopic: true,
        });
      }
    }
  }

  private extractJsonFromMarkdown(text: string): string {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      return jsonObjectMatch[0];
    }

    return text.trim();
  }

  async cancelRun(
    threadId: string,
    runId: string,
    messageId: string,
  ): Promise<boolean> {
    this.cancelledMessages.add(messageId);
    this.logger.log(`Message ${messageId} marked as cancelled`);

    // Best-effort OpenAI cancel - don't wait or fail if it errors
    this.openai.beta.threads.runs
      .cancel(runId, { thread_id: threadId })
      .catch((error) => {
        this.logger.warn(`OpenAI cancel failed (may already be done): ${error.message}`);
      });

    return true;
  }

  isCancelled(messageId: string): boolean {
    return this.cancelledMessages.has(messageId);
  }

  clearCancellation(messageId: string): void {
    this.cancelledMessages.delete(messageId);
  }

  private async emitEvent(
    sessionId: string,
    messageId: string,
    type: AIMatchEventType,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await this.eventPublisher.publish(
      sessionId,
      createEvent(type, sessionId, messageId, data),
    );
  }

  private buildUserPrompt(
    prompt: string,
    excludeIds?: string[],
    maxResults?: number,
  ): string {
    let userPrompt = `Find developers matching: "${prompt}"`;
    if (excludeIds?.length) {
      userPrompt += `\n\nExclude these developer IDs: ${excludeIds.join(', ')}`;
    }
    if (maxResults) {
      userPrompt += `\n\nReturn at most ${maxResults} matches.`;
    }
    userPrompt +=
      '\n\nUse the available tools to search and analyze developers, then return the best matches.';
    return userPrompt;
  }

  private summarizeToolResult(toolName: string, result: unknown): string {
    switch (toolName) {
      case 'search_by_role':
        return `Found ${Array.isArray(result) ? result.length : 0} developers for this role`;
      case 'search_developers':
        return `Found ${Array.isArray(result) ? result.length : 0} developers matching criteria`;
      case 'get_developer_details': {
        const dev = result as { firstName?: string; lastName?: string } | null;
        return dev
          ? `Retrieved profile for ${dev.firstName} ${dev.lastName}`
          : 'Developer not found';
      }
      case 'get_available_tech_stack':
        return `${Array.isArray(result) ? result.length : 0} technologies available`;
      case 'get_developer_statistics': {
        const stats = result as { total?: number } | null;
        return `${stats?.total ?? 0} developers in database`;
      }
      default:
        return 'Tool executed';
    }
  }
}
