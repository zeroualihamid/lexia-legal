import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import OpenAI from 'openai';
import { EmbeddingService } from './embedding.service';
import { RagService } from './rag.service';
import { ToolExecutorService } from './tool-executor.service';
import { PostgresService } from '../../../database/postgres.service';
import { AgentDocsClient } from '../../agent-docs/agent-docs.client';
import { MinioService } from '../../storage/minio.service';
import type { AgentSearchHit } from '../../agent-docs/agent-docs.client';
import { AuthUser } from '../../../common/guards/keycloak.guard';
import type { CaseReferenceCapture } from '../../cases/cases.service';
import { CHAT_UPLOAD_INBOX_CASE } from '../../chat-uploads/chat-uploads.constants';

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
    private minioService: MinioService,
  ) {
    const baseURL = this.configService.get<string>('llm.baseURL');
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('llm.apiKey'),
      ...(baseURL ? { baseURL } : {}),
    });
    this.chatModel = this.configService.get<string>('llm.chatModel') || 'gpt-4o';
  }

  /** General chat (all user docs, or one case when `caseId` is set + global corpus). */
  async streamChat(
    conversationId: string,
    question: string,
    user: AuthUser,
    res: Response,
    opts?: { caseId?: string },
  ): Promise<void> {
    await this.executeChat({
      question,
      user,
      res,
      conversationId,
      userDocScope: user.userId
        ? opts?.caseId
          ? { caseId: opts.caseId }
          : {}
        : null,
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

      const judgmentLibraryMode =
        !opts.userDocScope?.caseId && this.isJudgmentLibraryQuery(question);

      // Global legal corpus retrieval (laws + judgments) — skipped when the
      // user is searching their own uploaded judgments to avoid hallucination.
      let collectionRoutes: Array<{ collection: string; score: number }> = [];
      let searchResults: Awaited<ReturnType<RagService['search']>> = [];
      if (!judgmentLibraryMode) {
        collectionRoutes = await this.ragService.routeCollections(
          question,
          this.openai,
          this.chatModel,
        );
        const collections = collectionRoutes.map((r) => r.collection);
        this.sendSSE(res, 'collections', { collections: collectionRoutes });

        searchResults = await this.ragService.search(
          question,
          collections,
          user.accessLevel,
          user.userId,
          this.openai,
        );
      }
      const corpusContext = judgmentLibraryMode
        ? ''
        : this.ragService.buildContext(searchResults);

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
      const caseScopeNote = await this.buildCaseScopeNote(
        opts.userDocScope?.caseId,
        user.userId,
      );

      const contextSections: string[] = [];
      if (refNote) contextSections.push(refNote);
      if (caseScopeNote) contextSections.push(caseScopeNote);
      if (casesNote) contextSections.push(casesNote);
      if (userDocs.context) contextSections.push(userDocs.context);
      if (corpusContext) contextSections.push(corpusContext);
      const mergedContext =
        contextSections.join('\n\n---\n\n') || 'لا توجد مصادر ذات صلة.';

      const judgmentIsolationRules = judgmentLibraryMode
        ? `
قواعد صارمة — بحث في مستندات المستخدم المرفوعة:
- أجب حصرياً من نصوص مستندات المستخدم في السياق أدناه (أحكام/قرارات مرفوعة)
- إذا وُجد حكم مطابق، اذكر اسمه الكامل ورقم الملف/المرجع كما في المستند ولا تختلق مبادئ من خارج النص
- إذا كان السياق فارغاً أو لا يحتوي الحكم المطلوب، قُل صراحةً أنه لا يوجد حكم مطابق في مكتبتك — لا تستخدم معرفتك العامة ولا تختلق أحكاماً
- إلزامي: بعد إجابتك مباشرةً، أدرج كتلة <SRC> (نسخاً حرفياً من سجل المصادر) لكل مستند استشهدت به — بدونها لن تظهر أزرار PDF والملخص`
        : '';

      const systemPrompt = `أنت مساعد قانوني ذكي ومدير ملفات متخصص في القانون المغربي، تساعد المحامي على إدارة قضاياه والتحاور حول الأحكام والاستراتيجية. تقدم معلومات قانونية دقيقة ومفصلة باللغة العربية.
${judgmentIsolationRules}

قواعد:
- استند إلى مستندات المستخدم (إن وُجدت) وإلى النصوص القانونية والأحكام القضائية المغربية المنشورة
- إذا حُدّدت قضية معيّنة في السياق، فاستخدم فقط مستندات تلك القضية من قسم «مستندات هذه القضية» ولا تستشهد بمستندات قضايا أخرى (عقود، مراسلات، ملفات…) حتى لو بدت ذات صلة
- إذا وُجدت مستندات القضية في السياق (خاصة عقود)، فأجب مباشرة من نصها: استخرج موضوع العقد أو البند المطلوب واقتبسه. لا تطلب من المستخدم تحديد العقد إذا كان العقد موجوداً في مستندات القضية
- أجب بلغة سؤال المستخدم (عربية أو فرنسية) ما لم يطلب غير ذلك
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

      const corpusSources =
        user.accessLevel !== 'PUBLIC' && !judgmentLibraryMode
          ? searchResults.map((r) => ({
              id: r.id,
              collection: r.collection,
              titleAr: r.titleAr,
              titleFr: r.titleFr,
              articleRef: r.articleRef,
              score: r.score,
            }))
          : [];
      const docSourcesRaw = userDocs.sources.map((s) => ({
        id: s.documentId,
        collection: 'user_documents',
        titleAr: s.titleAr,
        docType: s.docType,
        score: s.score,
      }));
      const enrichedDocSources =
        await this.enrichDocumentSourcesWithUrls(docSourcesRaw);
      const { docSources: citeDocSources, corpusSources: citeCorpusSources } =
        this.selectCitationSources(
          enrichedDocSources,
          corpusSources,
          judgmentLibraryMode,
        );
      const sourceCitationRules = this.buildSourceCitationInstructions(
        citeDocSources,
        citeCorpusSources,
      );
      if (citeCorpusSources.length > 0 || citeDocSources.length > 0) {
        this.sendSSE(res, 'sources', {
          sources: [...citeDocSources, ...citeCorpusSources],
        });
      }

      const systemPromptWithSources = sourceCitationRules
        ? `${systemPrompt}\n${sourceCitationRules}`
        : systemPrompt;

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPromptWithSources },
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

      // DeepSeek and similar models often skip <SRC> blocks despite instructions —
      // inject any missing blocks so the UI can render PDF/summary cards.
      const allowedSrcIds = new Set(
        [...citeDocSources, ...citeCorpusSources].map((s) => s.id),
      );
      const maxSrcBlocks = citeDocSources.length + citeCorpusSources.length;
      fullResponse = this.trimSrcBlocksToAllowed(
        fullResponse,
        allowedSrcIds,
        maxSrcBlocks,
      );

      const { text: responseWithSrc, injected: srcInjection } =
        this.injectMissingSrcBlocks(
          fullResponse,
          citeDocSources,
          citeCorpusSources,
        );
      if (srcInjection) {
        fullResponse = responseWithSrc;
        this.sendSSE(res, 'chunk', { content: srcInjection });
        this.logger.debug(
          `Injected ${srcInjection.length} chars of <SRC> blocks (model omitted them)`,
        );
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
      let hits: AgentSearchHit[] = [];

      if (caseId) {
        hits = await this.retrieveCaseScopedDocs(userId, caseId, question);
      } else {
        hits = await this.retrieveGeneralUserDocs(userId, question);
      }

      if (!hits.length) return { context: '', sources: [] };

      const ids = [...new Set(hits.map((h) => h.documentId).filter(Boolean))];
      const titleMap = new Map<
        string,
        { title_ar: string; document_type: string; case_id: string | null }
      >();
      if (ids.length > 0) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
        const docs = await this.postgresService.query<{
          id: string;
          title_ar: string;
          document_type: string;
          case_id: string | null;
        }>(
          `SELECT id, title_ar, document_type, case_id FROM documents WHERE id IN (${placeholders})`,
          ids,
        );
        docs.forEach((d) => titleMap.set(d.id, d));
      }

      const scopedHits = caseId
        ? hits.filter((h) => {
            const meta = titleMap.get(h.documentId);
            // Trust case-scoped retrieval; only exclude when we know it's another case.
            return !meta || meta.case_id === caseId;
          })
        : hits;

      if (!scopedHits.length) return { context: '', sources: [] };

      let context = caseId
        ? 'مستندات هذه القضية:\n\n'
        : 'مستنداتك الخاصة:\n\n';
      const sourceByDoc = new Map<
        string,
        {
          documentId: string;
          titleAr: string | null;
          docType: string | null;
          score: number;
        }
      >();
      scopedHits.forEach((h, i) => {
        const meta = titleMap.get(h.documentId);
        const title = meta?.title_ar || `مستند ${i + 1}`;
        context += `[م${i + 1}] ${title}\n${h.content}\n\n`;
        const prev = sourceByDoc.get(h.documentId);
        if (!prev || h.score > prev.score) {
          sourceByDoc.set(h.documentId, {
            documentId: h.documentId,
            titleAr: meta?.title_ar || null,
            docType: meta?.document_type || h.docType || null,
            score: h.score,
          });
        }
      });

      return { context, sources: [...sourceByDoc.values()] };
    } catch (err) {
      this.logger.warn(`User-doc retrieval failed: ${err.message}`);
      return { context: '', sources: [] };
    }
  }

  /**
   * Case chat needs stronger retrieval than a single semantic query: lawyers often
   * ask in French ("objet du contrat") while OCR is mixed FR/AR, and the first
   * chunk may not rank highly. We merge multi-query search, per-document search,
   * and OCR excerpts as a last resort.
   */
  private async retrieveCaseScopedDocs(
    userId: string,
    caseId: string,
    question: string,
  ): Promise<AgentSearchHit[]> {
    const caseDocs = await this.postgresService.query<{
      id: string;
      title_ar: string;
      document_type: string | null;
      ocr_text: string | null;
      status: string;
    }>(
      `SELECT id, title_ar, document_type, ocr_text, status
       FROM documents
       WHERE case_id = $1 AND owner_id = $2 AND status = 'ready'
       ORDER BY
         CASE WHEN document_type = 'contract' THEN 0 ELSE 1 END,
         created_at ASC`,
      [caseId, userId],
    );

    const hitMap = new Map<string, AgentSearchHit>();
    const absorb = (batch: AgentSearchHit[]) => {
      for (const h of batch) {
        if (!h.documentId || !h.content?.trim()) continue;
        const key = `${h.documentId}-${h.chunkIndex ?? 0}`;
        const prev = hitMap.get(key);
        if (!prev || h.score > prev.score) hitMap.set(key, h);
      }
    };

    // Always seed context from OCR when a case is selected — vector search alone
    // often misses short FR queries like "objet du contrat" (or typos: "ojet").
    if (caseDocs.length > 0) {
      const ocrHits = await this.buildCaseOcrFallbackHits(caseDocs, question);
      absorb(ocrHits);
    }

    const queries = this.buildCaseSearchQueries(question, caseDocs);
    await Promise.all(
      queries.map((q) =>
        this.agentDocsClient
          .search({ ownerId: userId, caseId, query: q, limit: 10 })
          .then(absorb)
          .catch(() => undefined),
      ),
    );

    // Per-document search so a single contract in the dossier is always considered.
    await Promise.all(
      caseDocs.slice(0, 6).map(async (doc) => {
        const docQueries = [
          question,
          `${doc.title_ar || ''} ${queries.slice(1).join(' ')}`.trim(),
        ];
        await Promise.all(
          [...new Set(docQueries.filter(Boolean))].map((q) =>
            this.agentDocsClient
              .search({
                ownerId: userId,
                caseId,
                documentId: doc.id,
                query: q,
                limit: 4,
              })
              .then(absorb)
              .catch(() => undefined),
          ),
        );
      }),
    );

    let merged = [...hitMap.values()].sort((a, b) => b.score - a.score);

    if (merged.length === 0 && caseDocs.length > 0) {
      const ocrHits = await this.buildCaseOcrFallbackHits(caseDocs, question);
      absorb(ocrHits);
      merged = [...hitMap.values()].sort((a, b) => b.score - a.score);
    }

    return merged.slice(0, 12);
  }

  /**
   * General chat: retrieve from the user's library (search uploads, chat
   * uploads, inbox-indexed docs). Uses multi-query search + OCR/title fallback
   * because FR queries often miss Arabic judgment OCR in a single vector pass.
   */
  private async retrieveGeneralUserDocs(
    userId: string,
    question: string,
  ): Promise<AgentSearchHit[]> {
    const userDocs = await this.postgresService.query<{
      id: string;
      title_ar: string;
      document_type: string | null;
      ocr_text: string | null;
      status: string;
    }>(
      `SELECT id, title_ar, document_type, ocr_text, status
       FROM documents
       WHERE owner_id = $1 AND status IN ('ready', 'published')
       ORDER BY
         CASE WHEN document_type = 'judgment' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 24`,
      [userId],
    );

    const hitMap = new Map<string, AgentSearchHit>();
    const absorb = (batch: AgentSearchHit[]) => {
      for (const h of batch) {
        if (!h.documentId || !h.content?.trim()) continue;
        const key = `${h.documentId}-${h.chunkIndex ?? 0}`;
        const prev = hitMap.get(key);
        if (!prev || h.score > prev.score) hitMap.set(key, h);
      }
    };

    absorb(await this.buildTitleMatchHits(userDocs, question));

    if (this.isJudgmentLibraryQuery(question) && userDocs.length > 0) {
      absorb(await this.buildJudgmentOcrFallbackHits(userDocs, question));
    }

    const queries = this.buildJudgmentSearchQueries(question);
    const searchJobs: Promise<void>[] = [];

    for (const q of queries) {
      searchJobs.push(
        this.agentDocsClient
          .search({ ownerId: userId, query: q, limit: 10 })
          .then(absorb)
          .catch(() => undefined),
      );
      searchJobs.push(
        this.agentDocsClient
          .search({
            ownerId: userId,
            caseId: CHAT_UPLOAD_INBOX_CASE,
            query: q,
            limit: 10,
          })
          .then(absorb)
          .catch(() => undefined),
      );
    }
    await Promise.all(searchJobs);

    const judgmentDocs = userDocs
      .filter((d) => d.document_type === 'judgment')
      .slice(0, 8);
    await Promise.all(
      judgmentDocs.map(async (doc) => {
        const docQueries = [
          question,
          `${doc.title_ar || ''} ${queries.slice(1, 3).join(' ')}`.trim(),
        ];
        await Promise.all(
          [...new Set(docQueries.filter(Boolean))].map((q) =>
            this.agentDocsClient
              .search({
                ownerId: userId,
                documentId: doc.id,
                query: q,
                limit: 4,
              })
              .then(absorb)
              .catch(() => undefined),
          ),
        );
      }),
    );

    let merged = [...hitMap.values()].sort((a, b) => b.score - a.score);

    if (merged.length === 0 && userDocs.length > 0) {
      absorb(await this.buildJudgmentOcrFallbackHits(userDocs, question));
      merged = [...hitMap.values()].sort((a, b) => b.score - a.score);
    }

    return merged.slice(0, 12);
  }

  /** True when the user is looking for a judgment in their uploaded library. */
  private isJudgmentLibraryQuery(question: string): boolean {
    const q = (question || '').toLowerCase();
    return (
      /jugement|arrêt|arret|cassation|decision|sentence|verdict|jurisprudence/.test(
        q,
      ) ||
      /حكم|قرار|نقض|محكمة\s*النقض|الاستئناف|قضاء/.test(q) ||
      /judgment|decision|ruling|precedent/.test(q) ||
      (/cherche|recherche|trouve|find|looking|search|أبحث|ابحث|أريد|je\s+veux/.test(
        q,
      ) &&
        /courtage|commission|immobilier|brokerage|real\s*estate/.test(q))
    );
  }

  private buildJudgmentSearchQueries(question: string): string[] {
    const q = (question || '').trim();
    const lower = q.toLowerCase();
    const queries = new Set<string>([q]);

    if (/cassation|arrêt|arret|jugement/.test(lower)) {
      queries.add(
        'jugement cassation cour de cassation arrêt محكمة النقض قرار نقض',
      );
    }
    if (/courtage|commission|immobilier|brokerage|agent\s+immobilier/.test(
      lower,
    )) {
      queries.add(
        'commission courtage immobilier agency broker وساطة عقارية عمولة',
      );
    }
    if (/paiement|payment|payable|دفع|أداء/.test(lower)) {
      queries.add('paiement commission courtage payment obligation');
    }
    if (/cherche|recherche|trouve|find|looking/.test(lower)) {
      queries.add('jugement cassation courtage immobilier commission');
    }

    return [...queries].filter(Boolean);
  }

  /** Score user documents by title/token overlap (helps FR query → AR title). */
  private async buildTitleMatchHits(
    docs: Array<{
      id: string;
      title_ar: string;
      document_type: string | null;
      ocr_text: string | null;
    }>,
    question: string,
  ): Promise<AgentSearchHit[]> {
    const qTokens = this.tokenize(question);
    if (!qTokens.length) return [];

    const topicTerms = [
      'cassation',
      'courtage',
      'commission',
      'immobilier',
      'نقض',
      'وساطة',
      'عقاري',
      'رافعي',
    ];
    const hits: AgentSearchHit[] = [];
    const lowerQ = question.toLowerCase();

    for (const doc of docs) {
      const title = (doc.title_ar || '').toLowerCase();
      const titleTokens = this.tokenize(title);
      let score = 0;
      for (const t of qTokens) {
        if (title.includes(t)) score += 2;
        if (titleTokens.includes(t)) score += 1;
      }
      for (const term of topicTerms) {
        if (
          (lowerQ.includes(term) || qTokens.includes(term)) &&
          title.includes(term)
        ) {
          score += 2;
        }
      }
      if (doc.document_type === 'judgment') score += 1;
      if (score < 2) continue;

      const text = await this.loadDocumentTextForRetrieval(doc);
      const excerpt = text
        ? this.extractRelevantExcerpt(text, question, 5000, true)
        : doc.title_ar;
      hits.push({
        documentId: doc.id,
        caseId: null,
        docType: doc.document_type,
        chunkIndex: 0,
        content: `[${doc.title_ar}]\n${excerpt}`,
        score: score + 8,
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 4);
  }

  private async buildJudgmentOcrFallbackHits(
    docs: Array<{
      id: string;
      title_ar: string;
      document_type: string | null;
      ocr_text: string | null;
    }>,
    question: string,
  ): Promise<AgentSearchHit[]> {
    const hits: AgentSearchHit[] = [];
    const prioritized = [...docs].sort((a, b) => {
      const aJ = a.document_type === 'judgment' ? 0 : 1;
      const bJ = b.document_type === 'judgment' ? 0 : 1;
      return aJ - bJ;
    });

    for (const doc of prioritized.slice(0, 6)) {
      const text = await this.loadDocumentTextForRetrieval(doc);
      if (!text) continue;
      const excerpt = this.extractRelevantExcerpt(text, question, 6000, true);
      if (!excerpt) continue;
      hits.push({
        documentId: doc.id,
        caseId: null,
        docType: doc.document_type,
        chunkIndex: 0,
        content: `[${doc.title_ar}]\n${excerpt}`,
        score: doc.document_type === 'judgment' ? 2 : 1,
      });
    }
    return hits;
  }

  private async enrichDocumentSourcesWithUrls(
    sources: Array<{
      id: string;
      collection: string;
      titleAr: string | null;
      docType?: string | null;
      score?: number;
    }>,
  ): Promise<
    Array<{
      id: string;
      collection: string;
      titleAr: string | null;
      docType?: string | null;
      score?: number;
      url?: string;
      fileName?: string;
      filePath?: string;
      hasSummary?: boolean;
    }>
  > {
    const ids = [...new Set(sources.map((s) => s.id).filter(Boolean))];
    if (!ids.length) return sources;

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await this.postgresService.query<{
      id: string;
      minio_bucket: string;
      minio_key: string;
      title_ar: string;
      document_type: string | null;
      analysis_status: string | null;
    }>(
      `SELECT d.id, d.minio_bucket, d.minio_key, d.title_ar, d.document_type,
              ja.status AS analysis_status
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT j.status
         FROM judgment_analyses j
         WHERE (
           (d.metadata->>'analysisId' IS NOT NULL AND j.id = (d.metadata->>'analysisId')::uuid)
           OR (j.pdf_bucket = d.minio_bucket AND j.pdf_key = d.minio_key)
         )
           AND j.status IN ('pending', 'running', 'completed')
         ORDER BY
           CASE j.status
             WHEN 'completed' THEN 0
             WHEN 'running' THEN 1
             WHEN 'pending' THEN 2
             ELSE 3
           END,
           j.completed_at DESC NULLS LAST,
           j.created_at DESC
         LIMIT 1
       ) ja ON true
       WHERE d.id IN (${placeholders})`,
      ids,
    );
    const rowMap = new Map(rows.map((r) => [r.id, r]));

    return Promise.all(
      sources.map(async (s) => {
        const row = rowMap.get(s.id);
        if (!row?.minio_bucket || !row?.minio_key) return s;
        try {
          const url = await this.minioService.getPresignedUrl(
            row.minio_bucket,
            row.minio_key,
            3600,
          );
          return {
            ...s,
            titleAr: s.titleAr || row.title_ar,
            url,
            fileName: row.minio_key.split('/').pop() || undefined,
            filePath: `${row.minio_bucket}/${row.minio_key}`,
            docType: s.docType || row.document_type,
            hasSummary:
              row.document_type === 'judgment' &&
              row.analysis_status === 'completed',
          };
        } catch {
          return {
            ...s,
            titleAr: s.titleAr || row.title_ar,
            fileName: row.minio_key.split('/').pop(),
            filePath: `${row.minio_bucket}/${row.minio_key}`,
            docType: s.docType || row.document_type,
            hasSummary:
              row.document_type === 'judgment' &&
              row.analysis_status === 'completed',
          };
        }
      }),
    );
  }

  /** Keep only the highest-scoring sources for citation cards (avoids flooding the UI). */
  private selectCitationSources<
    D extends { id: string; score?: number },
    C extends { id: string; score?: number },
  >(
    docSources: D[],
    corpusSources: C[],
    judgmentLibraryMode: boolean,
  ): { docSources: D[]; corpusSources: C[] } {
    const maxDocs = judgmentLibraryMode ? 1 : 2;
    const maxCorpus = judgmentLibraryMode ? 0 : 2;

    const rankedDocs = [...docSources].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0),
    );
    let docSourcesOut = rankedDocs.slice(0, maxDocs);

    // Drop a weak second doc when it clearly trails the best match.
    if (docSourcesOut.length >= 2) {
      const [best, runnerUp] = docSourcesOut;
      const bestScore = best.score ?? 0;
      const runnerScore = runnerUp.score ?? 0;
      if (runnerScore < bestScore * 0.65 && bestScore - runnerScore > 2) {
        docSourcesOut = [best];
      }
    }

    const corpusSourcesOut = [...corpusSources]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, maxCorpus);

    return { docSources: docSourcesOut, corpusSources: corpusSourcesOut };
  }

  /** Remove <SRC> blocks outside the allowed catalog or above the cap. */
  private trimSrcBlocksToAllowed(
    response: string,
    allowedIds: Set<string>,
    maxBlocks: number,
  ): string {
    if (maxBlocks <= 0) {
      return response.replace(/<SRC>[\s\S]*?<\/SRC>/gi, '');
    }

    let kept = 0;
    return response.replace(/<SRC>([\s\S]*?)<\/SRC>/gi, (full, body) => {
      if (!/^\s*id\s*:/im.test(full)) return '';
      const idMatch = body.match(/^\s*id\s*:\s*(.+)\s*$/im);
      if (!idMatch) return '';
      const id = idMatch[1].trim();
      if (!allowedIds.has(id)) return '';
      if (kept >= maxBlocks) return '';
      kept += 1;
      return full;
    });
  }

  /** Instruct the model to cite sources using inline <SRC> XML blocks. */
  private formatSrcBlock(
    id: string,
    title: string,
    path: string,
    type: string,
  ): string {
    return `<SRC>
id:${id}
title:${title.replace(/\n/g, ' ')}
path:${path}
type:${type}
</SRC>`;
  }

  /** Build concatenated <SRC> blocks for retrieved sources (server-side fallback). */
  private buildSrcBlocksFromSources(
    docSources: Array<{
      id: string;
      titleAr: string | null;
      filePath?: string;
      fileName?: string;
      docType?: string | null;
      score?: number;
    }>,
    corpusSources: Array<{
      id: string;
      titleAr?: string;
      titleFr?: string;
      articleRef?: string;
      collection?: string;
    }>,
  ): string {
    const blocks: string[] = [];

    for (const s of docSources) {
      const title = (s.titleAr || s.fileName || 'مستند').replace(/\n/g, ' ');
      const path = s.filePath || s.fileName || '—';
      const type = s.docType || 'other';
      blocks.push(this.formatSrcBlock(s.id, title, path, type));
    }

    for (const s of corpusSources.slice(0, 6)) {
      const title = (s.titleAr || s.titleFr || s.articleRef || 'مصدر').replace(
        /\n/g,
        ' ',
      );
      blocks.push(
        this.formatSrcBlock(s.id, title, s.collection || 'corpus', 'corpus'),
      );
    }

    return blocks.join('\n\n');
  }

  /** Append <SRC> blocks the model failed to emit. */
  private injectMissingSrcBlocks(
    response: string,
    docSources: Array<{
      id: string;
      titleAr: string | null;
      filePath?: string;
      fileName?: string;
      docType?: string | null;
      score?: number;
    }>,
    corpusSources: Array<{
      id: string;
      titleAr?: string;
      titleFr?: string;
      articleRef?: string;
      collection?: string;
    }>,
  ): { text: string; injected: string } {
    if (!docSources.length && !corpusSources.length) {
      return { text: response, injected: '' };
    }

    // Remove malformed <SRC> blocks (model sometimes emits free text without id:/path:/type:).
    const cleaned = response.replace(/<SRC>[\s\S]*?<\/SRC>/gi, (block) =>
      /^\s*id\s*:/im.test(block) ? block : '',
    );

    const citedIds = new Set<string>();
    const srcPattern = /<SRC>([\s\S]*?)<\/SRC>/gi;
    let match: RegExpExecArray | null;
    while ((match = srcPattern.exec(cleaned)) !== null) {
      const idLine = match[1].match(/^\s*id\s*:\s*(.+)\s*$/im);
      if (idLine) citedIds.add(idLine[1].trim());
    }

    const missingDocs = docSources
      .filter((s) => !citedIds.has(s.id))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const missingCorpus = corpusSources.filter((s) => !citedIds.has(s.id));

    if (!missingDocs.length && !missingCorpus.length) {
      return { text: cleaned, injected: '' };
    }

    const injected =
      '\n\n' + this.buildSrcBlocksFromSources(missingDocs, missingCorpus);
    return { text: cleaned + injected, injected };
  }

  /** Instruct the model to cite sources using inline <SRC> XML blocks. */
  private buildSourceCitationInstructions(
    docSources: Array<{
      id: string;
      titleAr: string | null;
      filePath?: string;
      fileName?: string;
      docType?: string | null;
      collection?: string;
    }>,
    corpusSources: Array<{
      id: string;
      titleAr?: string;
      titleFr?: string;
      articleRef?: string;
      collection?: string;
    }>,
  ): string {
    const blocks: string[] = [];

    for (const s of docSources) {
      const title = (s.titleAr || s.fileName || 'مستند').replace(/\n/g, ' ');
      const path = s.filePath || s.fileName || '—';
      const type = s.docType || 'other';
      blocks.push(this.formatSrcBlock(s.id, title, path, type));
    }

    for (const s of corpusSources.slice(0, 6)) {
      const title = (s.titleAr || s.titleFr || s.articleRef || 'مصدر').replace(
        /\n/g,
        ' ',
      );
      blocks.push(
        this.formatSrcBlock(s.id, title, s.collection || 'corpus', 'corpus'),
      );
    }

    if (!blocks.length) return '';

    return `
⚠️ تنسيق الاستشهاد بالمصادر — إلزامي:
- أدرج كتلة <SRC> واحدة فقط للمصدر الرئيسي الذي بنيت عليه إجابتك (لا تكرر ولا تُدرج مستندات لم تستخدمها).
- انسخ الكتلة حرفياً من سجل المصادر أدناه وألصقها في نهاية إجابتك.
- لا تختلق معرّفات أو مسارات — استخدم فقط الكتل المسجّلة أدناه.
- لا تضع روابط URL أو Markdown داخل <SRC>؛ الواجهة تعرض أزرار «فتح PDF» و«عرض الملخص» تلقائياً.
${blocks.length === 1 ? '- يوجد مصدر واحد فقط — أدرج كتلة <SRC> واحدة فقط.' : ''}
- مثال: [نص الإجابة...] ثم مباشرة:

${blocks[0]}

سجل المصادر (انسخ الكتلة المناسبة فقط):
${blocks.join('\n\n')}`;
  }

  /** Expand short / FR legal questions into retrieval-friendly variants. */
  private buildCaseSearchQueries(
    question: string,
    caseDocs: Array<{ title_ar: string; document_type: string | null }>,
  ): string[] {
    const q = (question || '').trim();
    const lower = q.toLowerCase();
    const queries = new Set<string>([q]);

    if (/objet|ojet|subject|موضوع|غرض|but/.test(lower)) {
      queries.add(
        'objet du contrat subject matter of the contract موضوع العقد غرض العقد',
      );
    }
    if (/contrat|contract|عقد|اتفاق|convention/.test(lower)) {
      queries.add('contrat agreement parties obligations clauses عقد اتفاق');
    }
    // Short FR requests like "donne moi l'objet du contrat"
    if (/donne|donner|give|أعط|اذكر|what is|quel est/.test(lower)) {
      queries.add('objet du contrat parties obligations prestations');
    }

    const contract = caseDocs.find((d) => d.document_type === 'contract');
    if (contract?.title_ar) {
      queries.add(`${contract.title_ar} objet contrat`);
    }

    return [...queries].filter(Boolean);
  }

  /** Inject OCR text when vector search misses (common for short FR queries). */
  private async buildCaseOcrFallbackHits(
    caseDocs: Array<{
      id: string;
      title_ar: string;
      document_type: string | null;
      ocr_text: string | null;
    }>,
    question: string,
  ): Promise<AgentSearchHit[]> {
    const hits: AgentSearchHit[] = [];
    const prioritized = [...caseDocs].sort((a, b) => {
      const aContract = a.document_type === 'contract' ? 0 : 1;
      const bContract = b.document_type === 'contract' ? 0 : 1;
      return aContract - bContract;
    });

    for (const doc of prioritized.slice(0, 3)) {
      const text = await this.loadDocumentTextForRetrieval(doc);
      if (!text) continue;
      hits.push({
        documentId: doc.id,
        caseId: null,
        docType: doc.document_type,
        chunkIndex: 0,
        content: this.extractRelevantExcerpt(text, question, 5000),
        score: 1,
      });
    }
    return hits;
  }

  private async loadDocumentTextForRetrieval(doc: {
    id: string;
    ocr_text: string | null;
  }): Promise<string> {
    if (doc.ocr_text?.trim()) return doc.ocr_text.trim();
    try {
      const buffer = await this.minioService.downloadFile(
        'ocr-output',
        `${doc.id}/ocr.md`,
      );
      return buffer.toString('utf-8').trim();
    } catch {
      return '';
    }
  }

  private extractRelevantExcerpt(
    text: string,
    question: string,
    maxLen: number,
    judgmentMode = false,
  ): string {
    const lowerText = text.toLowerCase();
    const markers = judgmentMode
      ? [
          'courtage',
          'commission',
          'immobilier',
          'cassation',
          'محكمة النقض',
          'نقض',
          'وساطة',
          'عقاري',
          'objet',
          'subject matter',
          'موضوع',
          'الغرض',
          'but du contrat',
          'objet du contrat',
        ]
      : [
          'objet',
          'subject matter',
          'موضوع',
          'الغرض',
          'but du contrat',
          'objet du contrat',
        ];
    const lowerQ = (question || '').toLowerCase();
    if (
      judgmentMode ||
      /objet|ojet|subject|موضوع|غرض|courtage|commission|cassation|jugement/.test(
        lowerQ,
      )
    ) {
      for (const marker of markers) {
        const idx = lowerText.indexOf(marker.toLowerCase());
        if (idx >= 0) {
          const start = Math.max(0, idx - 500);
          return text.slice(start, start + maxLen).trim();
        }
      }
    }
    return text.slice(0, maxLen).trim();
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

  /** When the user picked a case in chat, anchor the assistant to that dossier only. */
  private async buildCaseScopeNote(
    caseId: string | undefined,
    userId: string | undefined,
  ): Promise<string> {
    if (!caseId || !userId) return '';
    try {
      const row = await this.postgresService.queryOne<{
        title: string;
        case_ref: string | null;
        client_name: string | null;
      }>(
        `SELECT title, case_ref, client_name FROM cases WHERE id = $1 AND owner_id = $2`,
        [caseId, userId],
      );
      if (!row) return '';
      const docs = await this.postgresService.query<{
        title_ar: string;
        document_type: string | null;
        status: string;
      }>(
        `SELECT title_ar, document_type, status
         FROM documents
         WHERE case_id = $1 AND owner_id = $2
         ORDER BY created_at ASC`,
        [caseId, userId],
      );
      const readyDocs = docs.filter((d) => d.status === 'ready');

      const parts = [
        'نطاق القضية المحدّدة للمحادثة:',
        `القضية: ${row.title}`,
      ];
      if (row.client_name) parts.push(`الموكل: ${row.client_name}`);
      if (row.case_ref) parts.push(`المرجع: ${row.case_ref}`);
      if (readyDocs.length) {
        parts.push(
          `المستندات الجاهزة (${readyDocs.length}): ${readyDocs
            .map((d) => d.title_ar || d.document_type || 'مستند')
            .join('؛ ')}`,
        );
      }
      parts.push(
        'قيود مهمة: المحامي اختار هذه القضية في المحادثة — لا تطلب منه اسم القضية أو مرجعها. استخدم فقط مستندات هذه القضية من قسم «مستندات هذه القضية». لا تستشهد بمستندات قضايا أخرى. يمكنك الاستناد إلى القانون المغربي والأحكام المنشورة في المكتبة العامة.',
      );
      return parts.join('\n');
    } catch {
      return '';
    }
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
