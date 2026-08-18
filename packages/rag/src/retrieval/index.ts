import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { createDeepAgent, StateBackend, type SubAgent } from 'deepagents';
import { getLLM } from '../../../libs/llm-provider.js';
import { buildVectorStore } from '../ingestion/index.js';
import { getRetrievalConfig } from '../config.js';
import { retrieve } from './pipeline.js';
import { getGlobalBM25Retriever } from './retrievers/bm25.js';
import { getMaxDenseScore } from './types.js';
import { extractSectionPath } from '../chunking/compose.js';
import { createDashScopeReranker, type Reranker } from './rerankers/index.js';

const RAG_WORKFLOW_INSTRUCTIONS = `# Documentation Q&A workflow

Answer questions about LangChain using the indexed documentation corpus.

1. **Plan**: Use write_todos to break complex questions into focused search queries.
2. **Search**: Call search_documentation with a query. The tool saves matching chunks under /retrieved/ and returns their file paths.
3. **Analyze**: For each saved chunk file, delegate to the chunk-analyst subagent. Pass the file path so the analyst can read it. Run at most {max_concurrent_analysts} analysts in parallel.
4. **Synthesize**: Combine analyst reports into a final answer. Cite source URLs from the chunk headers.

If search results do not contain relevant information, reformulate the query and search again before answering from prior knowledge.`;

const SUBAGENT_DELEGATION_INSTRUCTIONS = `# Delegating to subagents

Hand off focused analysis work to the chunk-analyst subagent. Each subagent gets an isolated context, so large file content does not pollute the main conversation.

- chunk-analyst: Reads a single retrieved chunk file and returns a concise summary addressing the user's question.

When delegating:
- Keep each task focused on one specific file.
- Limit concurrent delegations to {max_concurrent_analysts} to avoid rate limits.
- After all analysts return, synthesize their findings with citations to the source URLs.`;

export async function createRagAgent(forceRebuild = false) {
    const retrievalConfig = getRetrievalConfig();
    const vectorStore = await buildVectorStore(forceRebuild);
    const bm25Retriever = getGlobalBM25Retriever();
    const backend = new StateBackend();
    const llm = getLLM();

    let reranker: Reranker | undefined;
    if (retrievalConfig.rerank.enabled) {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        if (!apiKey) {
            throw new Error('DASHSCOPE_API_KEY is required when rerank is enabled');
        }
        reranker = createDashScopeReranker({
            apiKey,
            model: retrievalConfig.rerank.model,
            rerankUrl: retrievalConfig.rerank.rerankUrl,
        });
        console.log(`🔄 Reranker enabled: ${retrievalConfig.rerank.model}, topN=${retrievalConfig.rerank.topN}`);
    }

    const searchDocumentation = tool(
        async ({ query }) => {
            const allCandidates = await retrieve(
                { vectorStore, bm25Retriever, llm, reranker },
                query,
                retrievalConfig,
            );

            const retrievedChunks = allCandidates.slice(0, retrievalConfig.topK);
            const maxDenseScore = getMaxDenseScore(allCandidates);
            if (
                retrievedChunks.length === 0 ||
                maxDenseScore < retrievalConfig.abstentionThreshold
            ) {
                return 'No documentation chunks passed the retrieval filters. Reformulate the query and call search_documentation again.';
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
    });

    return agent;
}
