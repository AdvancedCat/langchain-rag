import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { createDeepAgent, StateBackend, type SubAgent } from 'deepagents';
import { getLLM } from '../../../libs/llm-provider.js';
import { buildVectorStore } from '../ingestion/index.js';
import { getRetrievalConfig } from '../config.js';
import { retrieve } from './pipeline.js';
import { getGlobalBM25Retriever } from './retrievers/bm25.js';
import { getMaxDenseScore } from './types.js';
import { extractSectionPath, composeSearchText } from '../chunking/compose.js';
import { createDashScopeReranker, type Reranker } from './rerankers/index.js';
import {
    SpanKind,
    initCozeLoop,
    getLangChainTracingCallbacks,
    withCozeLoopSpan,
    startCozeLoopSpan,
    endCozeLoopSpan,
    failCozeLoopSpan,
    setSpanInput,
    truncateForSpan,
    createSubagentSpanMiddleware,
} from '../observability/index.js';

const ABSTENTION_MESSAGE =
    'No documentation chunks passed the retrieval filters. You may reformulate the query and call search_documentation again (at most 2 retries). If retries keep failing, state that the documentation does not contain the answer instead of answering from prior knowledge.';

const RAG_WORKFLOW_INSTRUCTIONS = `# Documentation Q&A workflow

Answer questions about LangChain using the indexed documentation corpus.

1. **Plan**: Use write_todos to break complex questions into focused search queries.
2. **Search**: Call search_documentation with a query. The tool saves matching chunks under /retrieved/ and returns their file paths.
3. **Analyze**: For each saved chunk file, delegate to the chunk-analyst subagent. Pass the file path so the analyst can read it. Run at most {max_concurrent_analysts} analysts in parallel.
4. **Synthesize**: Combine analyst reports into a final answer. Cite source URLs from the chunk headers.

If search results do not contain relevant information, reformulate the query and search again (at most 2 retries). If the reformulated searches still return nothing relevant, do NOT answer from prior knowledge — tell the user that the indexed documentation does not cover this question.`;

const SUBAGENT_DELEGATION_INSTRUCTIONS = `# Delegating to subagents

Hand off focused analysis work to the chunk-analyst subagent. Each subagent gets an isolated context, so large file content does not pollute the main conversation.

- chunk-analyst: Reads a single retrieved chunk file and returns a concise summary addressing the user's question.

When delegating:
- Keep each task focused on one specific file.
- Limit concurrent delegations to {max_concurrent_analysts} to avoid rate limits.
- After all analysts return, synthesize their findings with citations to the source URLs.`;

export interface CreateRagAgentOptions {
    /** 强制重建向量索引（--rebuild 守卫，见 vectorStore.ts） */
    forceRebuild?: boolean;
    /**
     * LangGraph checkpointer：传入后 agent 状态（messages、/retrieved/ 文件、todos）
     * 按 configurable.thread_id 持久化，支撑 API 服务的多轮会话与断线恢复
     * （docs/api-service-plan.md §7.3）。CLI 不传，行为不变。
     */
    checkpointer?: BaseCheckpointSaver;
}

export async function createRagAgent(opts: CreateRagAgentOptions = {}) {
    const { forceRebuild = false, checkpointer } = opts;
    // CozeLoop：CLI 与 api 两条入口都经此构建 agent，这里统一初始化（幂等）。
    // 必须先于 getLLM——实例级回调取决于 enabled 状态（方案 §3.1）。
    initCozeLoop();
    const retrievalConfig = getRetrievalConfig();
    const vectorStore = await buildVectorStore(forceRebuild);
    const bm25Retriever = getGlobalBM25Retriever();
    const backend = new StateBackend();
    const llm = getLLM({ callbacks: getLangChainTracingCallbacks() });

    let reranker: Reranker | undefined;
    if (retrievalConfig.rerank.enabled || retrievalConfig.rerankGate.enabled) {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        if (!apiKey) {
            throw new Error('DASHSCOPE_API_KEY is required when rerank or the rerank gate is enabled');
        }
        reranker = createDashScopeReranker({
            apiKey,
            model: retrievalConfig.rerank.model,
            rerankUrl: retrievalConfig.rerank.rerankUrl,
        });
        if (retrievalConfig.rerank.enabled) {
            console.log(`🔄 Reranker enabled: ${retrievalConfig.rerank.model}, topN=${retrievalConfig.rerank.topN}`);
        }
        if (retrievalConfig.rerankGate.enabled) {
            console.log(
                `🚪 Rerank abstention gate enabled: ${retrievalConfig.rerank.model}, threshold=${retrievalConfig.rerankGate.threshold} (ranking unchanged)`,
            );
            if (retrievalConfig.rerank.enabled) {
                console.log(
                    '⚠️ Fusion rerank + gate both enabled: each search calls the rerank API twice ' +
                        '(pipeline scores the rewritten query, gate scores the raw query — signals differ, not reusable)',
                );
            }
        }
    }

    const searchDocumentation = tool(
        async ({ query }) =>
            // CozeLoop tool span：包住整个工具执行，内部的 retrieval/gate/LLM span
            // （query rewrite）自动挂为其子 span；recordOutputs 打开——工具返回值
            // （保存路径清单/弃答话术）即 span output。
            withCozeLoopSpan(
                'search_documentation',
                SpanKind.Tool,
                async (span) => {
                    setSpanInput(span, { query: truncateForSpan(query) });

                    const allCandidates = await retrieve(
                        { vectorStore, bm25Retriever, llm, reranker },
                        query,
                        retrievalConfig,
                    );

                    const retrievedChunks = allCandidates.slice(0, retrievalConfig.topK);
                    if (retrievedChunks.length === 0) {
                        return ABSTENTION_MESSAGE;
                    }

                    const maxDenseScore = getMaxDenseScore(allCandidates);
                    const denseAbstain = maxDenseScore < retrievalConfig.abstentionThreshold;

                    if (reranker && retrievalConfig.rerankGate.enabled) {
                        // 闸门信号：cross-encoder 对 top-fetchK 候选打分（输入文本与 embedding/BM25 同构，决策 D3）。
                        // 排序不变；API 失败或退化响应回退 dense cosine 阈值。
                        // CozeLoop：决策多早退 return，用 start/end 手动 span 记录（方案 §3.3）。
                        const gateSpan = startCozeLoopSpan('retrieval.gate', SpanKind.Retriever, {
                            attributes: { threshold: retrievalConfig.rerankGate.threshold },
                        });
                        try {
                            const gatePool = allCandidates.slice(0, retrievalConfig.fetchK);
                            const documents = gatePool.map((c) =>
                                composeSearchText(c.document.pageContent, c.document.metadata),
                            );
                            const results = await reranker.rank(query, documents, documents.length);
                            if (results.length === 0) {
                                // 200 但缺 output.results 的退化响应会让 bestScore 归零 → 恒弃答，必须按失败处理
                                throw new Error('rerank API returned no results for the candidate pool');
                            }
                            const bestRerankScore = results.reduce(
                                (max, r) => Math.max(max, r.relevanceScore),
                                0,
                            );
                            const topDocPath = (
                                gatePool[0]?.document.metadata as Record<string, unknown> | undefined
                            )?.docPath;
                            const decision =
                                bestRerankScore < retrievalConfig.rerankGate.threshold ? 'ABSTAIN' : 'PASS';
                            endCozeLoopSpan(gateSpan, {
                                decision,
                                best_rerank_score: Number(bestRerankScore.toFixed(4)),
                                max_dense_score: Number(maxDenseScore.toFixed(4)),
                                top_doc_path: topDocPath ?? null,
                                candidates: allCandidates.length,
                            });
                            console.log(
                                `🚪 Gate: rerank=${bestRerankScore.toFixed(4)} ` +
                                    `threshold=${retrievalConfig.rerankGate.threshold} ` +
                                    `dense=${maxDenseScore.toFixed(4)} candidates=${allCandidates.length} ` +
                                    `top=${String(topDocPath ?? '?')} query="${query}" → ${decision}`,
                            );
                            if (bestRerankScore < retrievalConfig.rerankGate.threshold) {
                                return ABSTENTION_MESSAGE;
                            }
                        } catch (error) {
                            failCozeLoopSpan(gateSpan, error, { decision: 'ERROR_FALLBACK_DENSE' });
                            console.warn(
                                `[RerankGate] API failed, falling back to dense threshold: ${error instanceof Error ? error.message : String(error)}`,
                            );
                            if (denseAbstain) {
                                return ABSTENTION_MESSAGE;
                            }
                        }
                    } else if (denseAbstain) {
                        return ABSTENTION_MESSAGE;
                    }

                    const batchId = randomUUID().slice(0, 8);
                    const uploads: Array<[string, Uint8Array]> = [];
                    const savedPaths: string[] = [];

                    retrievedChunks.forEach(({ document, score }, index) => {
                        const path = `/retrieved/${batchId}/chunk_${index + 1}.md`;
                        const displayScore = score.toFixed(4);
                        const sectionPath = extractSectionPath(document.metadata);
                        const sectionLine =
                            sectionPath && sectionPath.length > 0
                                ? `# Section: ${sectionPath.join(' > ')}\n`
                                : '';
                        const content =
                            `# Source: ${document.metadata?.source ?? 'unknown'}\n` +
                            sectionLine +
                            `# Retrieval score: ${displayScore}\n\n` +
                            document.pageContent;
                        uploads.push([path, new TextEncoder().encode(content)]);
                        savedPaths.push(path);
                    });

                    await backend.uploadFiles(uploads);
                    return `Saved ${savedPaths.length} documentation chunks:\n${savedPaths.join('\n')}`;
                },
                { recordOutputs: true },
            ),
        {
            name: 'search_documentation',
            description:
                'Search LangChain documentation and save matching chunks to the agent filesystem under /retrieved/.',
            schema: z.object({
                query: z.string().describe('Natural language search query.'),
            }),
        },
    );

    const maxConcurrentAnalysts = 3;
    const systemPrompt =
        RAG_WORKFLOW_INSTRUCTIONS.replaceAll(
            '{max_concurrent_analysts}',
            String(maxConcurrentAnalysts),
        ) +
        '\n\n' +
        '='.repeat(80) +
        '\n\n' +
        SUBAGENT_DELEGATION_INSTRUCTIONS.replaceAll(
            '{max_concurrent_analysts}',
            String(maxConcurrentAnalysts),
        );

    const chunkAnalyst: SubAgent = {
        name: 'chunk-analyst',
        description:
            "Reads a single retrieved documentation chunk file and returns a concise, focused summary answering the user's question.",
        systemPrompt:
            'You are a documentation analyst. Read the chunk file at the path provided to you using read_file. ' +
            "Return a concise summary that directly answers or relates to the user's question, and include the " +
            'source URL from the file header. If the chunk is not relevant, say so briefly.',
    };

    const modelName = process.env.LLM_MODEL ?? 'deepseek-v4-flash';
    console.log(`🧠 Using LLM: deepseek:${modelName}`);

    const agent = createDeepAgent({
        model: llm,
        tools: [searchDocumentation],
        subagents: [chunkAnalyst],
        systemPrompt,
        backend,
        checkpointer,
        // CozeLoop：包住 deepagents task 工具的执行，为子代理建 span——
        // 其内部全部 LLM 调用借此挂到层级树上，而非平铺在根 span（方案 §3.3）
        middleware: [createSubagentSpanMiddleware()],
    });

    return agent;
}
