import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import OpenAI from 'openai';
import { EmbeddingService } from './embedding.service';
import { RagService } from './rag.service';
import { ToolExecutorService } from './tool-executor.service';
import { PostgresService } from '../../../database/postgres.service';
import { AuthUser } from '../../../common/guards/keycloak.guard';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private openai: OpenAI;

  constructor(
    private configService: ConfigService,
    private embeddingService: EmbeddingService,
    private ragService: RagService,
    private toolExecutorService: ToolExecutorService,
    private postgresService: PostgresService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
    });
  }

  async streamChat(
    conversationId: string,
    question: string,
    user: AuthUser,
    res: Response,
  ): Promise<void> {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Heartbeat
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    try {
      // 1. Load active agent config
      const agentConfig = await this.loadAgentConfig();

      // 2. Load conversation history (PRO+)
      const history = await this.loadHistory(conversationId, user);

      // 3. Route to collections
      const collectionRoutes = await this.ragService.routeCollections(question, this.openai);
      const collections = collectionRoutes.map((r) => r.collection);
      this.sendSSE(res, 'collections', { collections: collectionRoutes });

      // 4. RAG search
      const searchResults = await this.ragService.search(
        question,
        collections,
        user.accessLevel,
        user.userId,
        this.openai,
      );
      const context = this.ragService.buildContext(searchResults);

      // 5. Build system prompt
      const skillPrompts = (agentConfig?.skills || [])
        .map((s: any) => s.prompt_content)
        .join('\n\n');

      const systemPrompt = `أنت مساعد قانوني متخصص في القانون المغربي. تقدم معلومات قانونية دقيقة ومفصلة باللغة العربية.

قواعد:
- استند دائماً إلى النصوص القانونية والأحكام القضائية المغربية
- اذكر المصادر بوضوح (رقم المادة، اسم القانون، رقم الحكم)
- إذا لم تجد معلومات كافية، أخبر المستخدم بذلك صراحةً
- لا تقدم استشارة قانونية ملزمة، بل معلومات قانونية توجيهية

${skillPrompts}

السياق القانوني:
${context}`;

      // 6. Build tools list
      const tools = await this.buildToolsList(agentConfig);

      // 7. Build messages
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: question },
      ];

      // 8. Agent loop
      let fullResponse = '';
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let iteration = 0;
      const maxIterations = 5;

      while (iteration < maxIterations) {
        iteration++;

        const streamParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model: agentConfig?.model || 'gpt-4o',
          messages,
          stream: true,
          ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        };

        const stream = await this.openai.chat.completions.create(streamParams);

        let currentContent = '';
        const toolCalls: any[] = [];
        let finishReason = '';

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          finishReason = chunk.choices[0]?.finish_reason || finishReason;

          if (delta?.content) {
            currentContent += delta.content;
            fullResponse += delta.content;
            this.sendSSE(res, 'chunk', { content: delta.content });
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }

          if (chunk.usage) {
            totalPromptTokens += chunk.usage.prompt_tokens || 0;
            totalCompletionTokens += chunk.usage.completion_tokens || 0;
          }
        }

        if (currentContent) {
          messages.push({ role: 'assistant', content: currentContent });
        }

        // Handle tool calls
        if (finishReason === 'tool_calls' && toolCalls.length > 0) {
          const validToolCalls = toolCalls.filter((tc) => tc && tc.id);
          messages.push({
            role: 'assistant',
            content: currentContent || null,
            tool_calls: validToolCalls,
          });

          for (const tc of validToolCalls) {
            let toolResult: any;
            try {
              const toolArgs = JSON.parse(tc.function.arguments);
              const toolDef = await this.findTool(tc.function.name, agentConfig);
              toolResult = await this.toolExecutorService.executeTool(toolDef, toolArgs);
              this.sendSSE(res, 'tool_result', {
                tool: tc.function.name,
                result: toolResult,
              });
            } catch (err) {
              toolResult = { error: err.message };
              this.logger.error(`Tool execution error: ${err.message}`);
            }

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(toolResult),
            });
          }
          continue; // next iteration
        }

        break; // done
      }

      // 9. Send sources (non-PUBLIC)
      if (user.accessLevel !== 'PUBLIC' && searchResults.length > 0) {
        this.sendSSE(res, 'sources', {
          sources: searchResults.map((r) => ({
            id: r.id,
            collection: r.collection,
            titleAr: r.titleAr,
            titleFr: r.titleFr,
            articleRef: r.articleRef,
            score: r.score,
          })),
        });
      }

      // 10. Save to DB
      if (user.userId && conversationId) {
        await this.saveMessages(
          conversationId,
          question,
          fullResponse,
          totalPromptTokens,
          totalCompletionTokens,
        );
      }

      this.sendSSE(res, 'done', {
        tokens: {
          prompt: totalPromptTokens,
          completion: totalCompletionTokens,
        },
      });
    } catch (err) {
      this.logger.error(`Stream chat error: ${err.message}`, err.stack);
      this.sendSSE(res, 'error', { message: err.message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  private sendSSE(res: Response, eventType: string, data: any): void {
    res.write(`data: ${JSON.stringify({ type: eventType, ...data })}\n\n`);
  }

  private async loadAgentConfig(): Promise<any> {
    try {
      const config = await this.postgresService.queryOne<any>(
        `SELECT ac.*,
          json_agg(DISTINCT s.*) FILTER (WHERE s.id IS NOT NULL) as skills,
          json_agg(DISTINCT t.*) FILTER (WHERE t.id IS NOT NULL) as tools,
          json_agg(DISTINCT m.*) FILTER (WHERE m.id IS NOT NULL) as mcp_servers
         FROM agent_configs ac
         LEFT JOIN agent_config_skills acs ON acs.agent_config_id = ac.id
         LEFT JOIN skills s ON s.id = acs.skill_id AND s.is_active = true
         LEFT JOIN agent_config_tools act ON act.agent_config_id = ac.id
         LEFT JOIN tools t ON t.id = act.tool_id AND t.is_active = true
         LEFT JOIN agent_config_mcp acm ON acm.agent_config_id = ac.id
         LEFT JOIN mcp_servers m ON m.id = acm.mcp_server_id AND m.is_active = true
         WHERE ac.is_default = true
         GROUP BY ac.id
         LIMIT 1`,
      );
      return config;
    } catch {
      return { model: 'gpt-4o', skills: [], tools: [], mcp_servers: [] };
    }
  }

  private async loadHistory(
    conversationId: string,
    user: AuthUser,
  ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    if (!conversationId || user.accessLevel === 'PUBLIC') return [];

    try {
      const messages = await this.postgresService.query<{
        role: string;
        content: string;
      }>(
        `SELECT role, content FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [conversationId],
      );

      return messages.reverse().map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
    } catch {
      return [];
    }
  }

  private async buildToolsList(agentConfig: any): Promise<OpenAI.Chat.ChatCompletionTool[]> {
    const tools: OpenAI.Chat.ChatCompletionTool[] = [];

    const agentTools: any[] = agentConfig?.tools || [];
    for (const tool of agentTools) {
      if (!tool || !tool.is_active) continue;
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description_ar || tool.description,
          parameters: tool.parameters_schema || { type: 'object', properties: {} },
        },
      });
    }

    const mcpServers: any[] = agentConfig?.mcp_servers || [];
    for (const server of mcpServers) {
      if (!server || !server.is_active) continue;
      const serverTools: any[] = server.tools_schema || [];
      for (const t of serverTools) {
        tools.push({
          type: 'function',
          function: {
            name: `mcp_${server.name}_${t.name}`,
            description: t.description,
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    }

    return tools;
  }

  private async findTool(name: string, agentConfig: any): Promise<any> {
    const tools: any[] = agentConfig?.tools || [];
    const direct = tools.find((t) => t?.name === name);
    if (direct) return direct;

    const mcpServers: any[] = agentConfig?.mcp_servers || [];
    for (const server of mcpServers) {
      if (!server) continue;
      const prefix = `mcp_${server.name}_`;
      if (name.startsWith(prefix)) {
        const toolName = name.slice(prefix.length);
        return {
          tool_type: 'mcp',
          endpoint: server.endpoint,
          name: toolName,
          timeout_ms: 30000,
          implementation_code: '',
        };
      }
    }

    throw new Error(`Tool not found: ${name}`);
  }

  private async saveMessages(
    conversationId: string,
    userMessage: string,
    assistantMessage: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    try {
      await this.postgresService.query(
        `INSERT INTO messages (conversation_id, role, content, tokens_used)
         VALUES ($1, 'user', $2, 0),
                ($1, 'assistant', $3, $4)`,
        [conversationId, userMessage, assistantMessage, promptTokens + completionTokens],
      );

      await this.postgresService.query(
        `UPDATE conversations SET updated_at = NOW(), message_count = message_count + 2
         WHERE id = $1`,
        [conversationId],
      );
    } catch (err) {
      this.logger.error(`Failed to save messages: ${err.message}`);
    }
  }
}
