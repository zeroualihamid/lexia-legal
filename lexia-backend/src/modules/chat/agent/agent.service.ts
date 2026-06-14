import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import OpenAI from 'openai';
import { EmbeddingService } from './embedding.service';
import { RagService } from './rag.service';
import { ToolExecutorService } from './tool-executor.service';
import { PostgresService } from '../../../database/postgres.service';
import { AgentDocsClient } from '../../agent-docs/agent-docs.client';
import { AuthUser } from '../../../common/guards/keycloak.guard';
import type { CaseReferenceCapture } from '../../cases/cases.service';

interface UserDocsContext {
  context: string;
  sources: Array<{
    documentId: string;
    titleAr: string | null;
    docType: string | null;
    score: number;
  }>;
}

interface MatchedCase {
  id: string;
  title: string;
  caseRef: string | null;
  clientName: string | null;
  status: string | null;
  documentCount: number;
}

// Words that carry no case-matching signal (FR/AR/EN connectors + "dossier"/"ملف").
const CASE_STOPWORDS = new Set([
  'dossier', 'dossiers', 'affaire', 'affaires', 'case', 'file', 'files',
  'vs', 'v', 'versus', 'contre', 'the', 'de', 'du', 'des', 'la', 'le', 'les',
  'et', 'un', 'une', 'pour', 'sur', 'avec',
  'ملف', 'ملفات', 'قضية', 'القضية', 'قضايا', 'دعوى', 'ضد', 'و', 'في', 'عن',
  'حول', 'ما', 'هو', 'هي', 'مع', 'على', 'الى', 'إلى', 'من',
]);

interface ExecuteChatOptions {
  question: string;
  user: AuthUser;
  res: Response;
  conversationId?: string;
  /**
   * When set, the user's own documents are retrieved from the agent and merged
   * into the context. `caseId` undefined => all of the user's documents
   * (general chat); `caseId` set => only that case's documents (case chat).
   */
  userDocScope?: { caseId?: string } | null;
  saveHistory?: boolean;
  /**
   * Result of detecting (and persisting) a court-file reference the user typed
   * into a case chat. When set, the assistant is told about it and an SSE
   * `case_reference` event is emitted so the UI can refresh the case.
   */
  referenceCapture?: CaseReferenceCapture | null;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private openai: OpenAI;
  private readonly chatModel: string;

  constructor(
    private configService: ConfigService,
    private embeddingService: EmbeddingService,
    private ragService: RagService,
    private toolExecutorService: ToolExecutorService,
    private postgresService: PostgresService,
    private agentDocsClient: AgentDocsClient,
  ) {
    const baseURL = this.configService.get<string>('llm.baseURL');
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('llm.apiKey'),
      ...(baseURL ? { baseURL } : {}),
    });
    this.chatModel = this.configService.get<string>('llm.chatModel') || 'gpt-4o';
  }

  /** General chat (entire knowledge base = all the user's docs + global corpus). */
  async streamChat(
    conversationId: string,
    question: string,
    user: AuthUser,
    res: Response,
  ): Promise<void> {
    await this.executeChat({
      question,
      user,
      res,
      conversationId,
      // Authenticated users also get their full document base merged in.
      userDocScope: user.userId ? {} : null,
      saveHistory: true,
    });
  }

  /** Case chat (one case's documents + global corpus). */
  async streamScopedChat(
    caseId: string,
    question: string,
    user: AuthUser,
    res: Response,
    opts?: { referenceCapture?: CaseReferenceCapture | null },
  ): Promise<void> {
    await this.executeChat({
      question,
      user,
      res,
      userDocScope: { caseId },
      saveHistory: false,
      referenceCapture: opts?.referenceCapture ?? null,
    });
  }

  private async executeChat(opts: ExecuteChatOptions): Promise<void> {
    const { question, user, res, conversationId } = opts;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    try {
      // Acknowledge a captured court reference up-front so the UI can refresh
      // the case (status tag, mahakim panel) while the answer streams.
      const refNote = this.buildReferenceNote(opts.referenceCapture);
      if (opts.referenceCapture?.updated) {
        this.sendSSE(res, 'case_reference', {
          caseRef: opts.referenceCapture.caseRef,
          mahakimStatus: opts.referenceCapture.mahakimStatus,
          mahakimSupported: opts.referenceCapture.mahakimSupported,
          parsed: opts.referenceCapture.parsed,
        });
      }

      const agentConfig = await this.loadAgentConfig();
      const history = opts.saveHistory
        ? await this.loadHistory(conversationId, user)
        : [];

      // Global legal corpus retrieval (laws + judgments).
      const collectionRoutes = await this.ragService.routeCollections(
        question,
        this.openai,
        this.chatModel,
      );
      const collections = collectionRoutes.map((r) => r.collection);
      this.sendSSE(res, 'collections', { collections: collectionRoutes });

      const searchResults = await this.ragService.search(
        question,
        collections,
        user.accessLevel,
        user.userId,
        this.openai,
      );
      const corpusContext = this.ragService.buildContext(searchResults);

      // User-document retrieval (case-scoped or all-my-docs), merged in.
      let userDocs: UserDocsContext = { context: '', sources: [] };
      if (opts.userDocScope && user.userId) {
        userDocs = await this.retrieveUserDocs(
          user.userId,
          question,
          opts.userDocScope.caseId,
        );
      }

      // Case-registry retrieval (general chat only): match the lawyer's own
      // cases by name/parties/reference so the agent can link to them and
      // discuss strategy, instead of only searching document chunks.
      let matchedCases: MatchedCase[] = [];
      if (opts.userDocScope && !opts.userDocScope.caseId && user.userId) {
        matchedCases = await this.searchUserCases(user.userId, question);
        if (matchedCases.length > 0) {
          this.sendSSE(res, 'cases', { cases: matchedCases });
        }
      }

      const skillPrompts = (agentConfig?.skills || [])
        .map((s: any) => s.prompt_content)
        .join('\n\n');

      const casesNote = this.buildCasesNote(matchedCases);

      const contextSections: string[] = [];
      if (refNote) contextSections.push(refNote);
      if (casesNote) contextSections.push(casesNote);
      if (userDocs.context) contextSections.push(userDocs.context);
      if (corpusContext) contextSections.push(corpusContext);
      const mergedContext =
        contextSections.join('\n\n---\n\n') || 'لا توجد مصادر ذات صلة.';

      const systemPrompt = `أنت مساعد قانوني ذكي ومدير ملفات متخصص في القانون المغربي، تساعد المحامي على إدارة قضاياه والتحاور حول الأحكام والاستراتيجية. تقدم معلومات قانونية دقيقة ومفصلة باللغة العربية.

قواعد:
- استند إلى مستندات المستخدم (إن وُجدت) وإلى النصوص القانونية والأحكام القضائية المغربية
- ميّز بوضوح بين ما يأتي من مستندات المستخدم وما يأتي من القانون العام أو الأحكام القضائية
- اذكر المصادر بوضوح (رقم المادة، اسم القانون، رقم الحكم، أو اسم المستند)
- إذا كان طلب المستخدم يخص قضية من قضاياه المسجّلة، فحدّد القضية المطابقة من قسم «القضايا المسجّلة لدى المحامي»، وأكّد للمستخدم وجودها صراحةً باسمها ومرجعها. لا تقل أبداً إن القضية غير موجودة إذا ظهرت في تلك القائمة، حتى لو لم تتضمن مستنداتها ما يكفي من التفاصيل
- ستعرض الواجهة بطاقات/روابط قابلة للنقر لفتح القضية المطابقة؛ لذلك لا تختلق روابط أو معرّفات
- بعد تحديد القضية، اقترح على المحامي أسئلة متابعة عملية حول استراتيجية الترافع والخطوات القادمة (مثل: المستندات الناقصة، آجال الطعن، تواريخ الجلسات، الدفوع الممكنة)
- إذا لم تجد معلومات كافية، أخبر المستخدم بذلك صراحةً
- لا تقدم استشارة قانونية ملزمة، بل معلومات قانونية توجيهية

${skillPrompts}

السياق:
${mergedContext}`;

      const tools = await this.buildToolsList(agentConfig);

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: question },
      ];

      let fullResponse = '';
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let iteration = 0;
      const maxIterations = 5;

      while (iteration < maxIterations) {
        iteration++;

        const streamParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model: this.chatModel || agentConfig?.model || 'gpt-4o',
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
          continue;
        }

        break;
      }

      // Sources: user documents (always for authenticated) + corpus (non-PUBLIC).
      const corpusSources =
        user.accessLevel !== 'PUBLIC'
          ? searchResults.map((r) => ({
              id: r.id,
              collection: r.collection,
              titleAr: r.titleAr,
              titleFr: r.titleFr,
              articleRef: r.articleRef,
              score: r.score,
            }))
          : [];
      const docSources = userDocs.sources.map((s) => ({
        id: s.documentId,
        collection: 'user_documents',
        titleAr: s.titleAr,
        docType: s.docType,
        score: s.score,
      }));
      if (corpusSources.length > 0 || docSources.length > 0) {
        this.sendSSE(res, 'sources', { sources: [...docSources, ...corpusSources] });
      }

      if (opts.saveHistory && user.userId && conversationId) {
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

  /** Retrieve the user's own document chunks (case-scoped or all) from the agent. */
  private async retrieveUserDocs(
    userId: string,
    question: string,
    caseId?: string,
  ): Promise<UserDocsContext> {
    try {
      const hits = await this.agentDocsClient.search({
        ownerId: userId,
        caseId,
        query: question,
        limit: 8,
      });
      if (!hits.length) return { context: '', sources: [] };

      const ids = [...new Set(hits.map((h) => h.documentId).filter(Boolean))];
      const titleMap = new Map<string, { title_ar: string; document_type: string }>();
      if (ids.length > 0) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
        const docs = await this.postgresService.query<{
          id: string;
          title_ar: string;
          document_type: string;
        }>(
          `SELECT id, title_ar, document_type FROM documents WHERE id IN (${placeholders})`,
          ids,
        );
        docs.forEach((d) => titleMap.set(d.id, d));
      }

      let context = caseId
        ? 'مستندات هذه القضية:\n\n'
        : 'مستنداتك الخاصة:\n\n';
      const sources = hits.map((h, i) => {
        const meta = titleMap.get(h.documentId);
        const title = meta?.title_ar || `مستند ${i + 1}`;
        context += `[م${i + 1}] ${title}\n${h.content}\n\n`;
        return {
          documentId: h.documentId,
          titleAr: meta?.title_ar || null,
          docType: meta?.document_type || h.docType || null,
          score: h.score,
        };
      });

      return { context, sources };
    } catch (err) {
      this.logger.warn(`User-doc retrieval failed: ${err.message}`);
      return { context: '', sources: [] };
    }
  }

  /**
   * Match the lawyer's own cases against the free-text question (title, client,
   * parties, reference, description). Returns the best matches so the agent can
   * confirm the case exists, link to it, and discuss strategy — rather than only
   * searching document chunks.
   */
  private async searchUserCases(
    userId: string,
    question: string,
    limit = 4,
  ): Promise<MatchedCase[]> {
    const tokens = this.tokenize(question);
    if (tokens.length === 0) return [];

    try {
      const rows = await this.postgresService.query<any>(
        `SELECT c.id, c.title, c.client_name, c.case_ref, c.description, c.status,
                COUNT(d.id)::int AS document_count
         FROM cases c
         LEFT JOIN documents d ON d.case_id = c.id
         WHERE c.owner_id = $1
         GROUP BY c.id`,
        [userId],
      );
      if (!rows.length) return [];

      const scored = rows
        .map((r) => {
          const title = (r.title || '').toLowerCase();
          const hay = [r.title, r.client_name, r.case_ref, r.description]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          let score = 0;
          for (const tok of tokens) {
            if (title.includes(tok)) score += 2; // title matches weigh more
            else if (hay.includes(tok)) score += 1;
          }
          return { r, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return scored.map(({ r }) => ({
        id: r.id,
        title: r.title,
        caseRef: r.case_ref || null,
        clientName: r.client_name || null,
        status: r.status || null,
        documentCount: r.document_count || 0,
      }));
    } catch (err) {
      this.logger.warn(`Case search failed: ${err.message}`);
      return [];
    }
  }

  /** Tokenise a query for case matching (drop connectors and short tokens). */
  private tokenize(text: string): string[] {
    return [
      ...new Set(
        (text || '')
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((t) => t.length >= 2 && !CASE_STOPWORDS.has(t)),
      ),
    ];
  }

  /** Arabic context block listing the matched cases for the system prompt. */
  private buildCasesNote(cases: MatchedCase[]): string {
    if (!cases.length) return '';
    const statusAr: Record<string, string> = {
      open: 'مفتوحة',
      closed: 'مغلقة',
      archived: 'مؤرشفة',
    };
    const lines = cases.map((c, i) => {
      const parts = [`[ق${i + 1}] ${c.title}`];
      if (c.clientName) parts.push(`الموكل: ${c.clientName}`);
      if (c.caseRef) parts.push(`المرجع: ${c.caseRef}`);
      parts.push(`الحالة: ${statusAr[c.status || ''] || c.status || '—'}`);
      parts.push(`عدد المستندات: ${c.documentCount}`);
      parts.push(`المعرّف: ${c.id}`);
      return parts.join(' — ');
    });
    return [
      'القضايا المسجّلة لدى المحامي والمطابقة لطلبك:',
      lines.join('\n'),
    ].join('\n');
  }

  private sendSSE(res: Response, eventType: string, data: any): void {
    res.write(`data: ${JSON.stringify({ type: eventType, ...data })}\n\n`);
  }

  /** Build an Arabic note telling the assistant a new court reference was saved. */
  private buildReferenceNote(cap?: CaseReferenceCapture | null): string {
    if (!cap?.updated) return '';
    const p = cap.parsed || ({} as any);
    const lines: string[] = [];
    if (p.courtName) lines.push(`- المحكمة: ${p.courtName}`);
    if (p.fileNumber) lines.push(`- رقم الملف: ${p.fileNumber}`);
    if (p.fileCode) lines.push(`- رمز الملف: ${p.fileCode}`);
    if (p.courtSection) lines.push(`- ${p.courtSection}`);
    if (p.courtPanel) lines.push(`- ${p.courtPanel}`);
    if (p.fileYear) lines.push(`- السنة: ${p.fileYear}`);

    let statusLine: string;
    if (cap.mahakimSupported && ['queued', 'processing'].includes(cap.mahakimStatus)) {
      statusLine =
        'تم إطلاق عملية جلب تلقائية من بوابة محاكم (mahakim.ma) في الخلفية لاسترجاع تواريخ الجلسات والمعطيات الإجرائية.';
    } else if (cap.mahakimStatus === 'unsupported') {
      statusLine =
        'ملاحظة: تتبع ملفات محكمة النقض غير متاح على بوابة محاكم العمومية (التي تغطي المحاكم الابتدائية ومحاكم الاستئناف فقط)، لذلك تم حفظ المرجع دون جلب آلي. يمكنك تزويدي بأي معطيات إضافية.';
    } else {
      statusLine = 'تم حفظ المرجع ضمن معطيات القضية.';
    }

    return [
      'تحديث استراتيجي لمعطيات القضية:',
      'أدخل المحامي مرجع الملف القضائي التالي، وقد تم حفظه ضمن بيانات هذه القضية:',
      lines.join('\n'),
      cap.caseRef ? `المرجع الموحّد: ${cap.caseRef}` : '',
      statusLine,
      'استند إلى هذه المعطيات عند الإجابة، واطلب أي معلومة ناقصة لإتمام تتبع الملف.',
    ]
      .filter(Boolean)
      .join('\n');
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
        `UPDATE conversations
         SET updated_at = NOW(),
             message_count = message_count + 2,
             title_ar = CASE
               WHEN title_ar IS NULL OR title_ar = 'محادثة جديدة'
               THEN LEFT($2, 80)
               ELSE title_ar
             END
         WHERE id = $1`,
        [conversationId, userMessage],
      );
    } catch (err) {
      this.logger.error(`Failed to save messages: ${err.message}`);
    }
  }
}
