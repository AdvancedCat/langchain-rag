import 'dotenv/config';

import { HumanMessage } from '@langchain/core/messages';
import { EXAMPLE_QUERY } from './config.js';
import { buildVectorStore } from './ingestion/index.js';
import { createRagAgent } from './retrieval/index.js';
import {
    withCozeLoopSpan,
    setSpanInput,
    setSpanOutput,
    getLangChainTracingCallbacks,
    shutdownCozeLoop,
    truncateForSpan,
    type Span,
} from './observability/index.js';

async function main() {
    const args = process.argv.slice(2);
    const isIndexOnly = args.includes('--index-only');
    const forceRebuild = args.includes('--rebuild');
    const query = args
        .filter((arg) => !arg.startsWith('--'))
        .join(' ')
        .trim() || EXAMPLE_QUERY;

    console.log('='.repeat(80));
    console.log('Deep Agents RAG - Documentation Q&A Agent');
    console.log('='.repeat(80));
    console.log();

    if (isIndexOnly) {
        await buildVectorStore(forceRebuild);
        console.log('Indexing complete.');
        return;
    }

    const agent = await createRagAgent({ forceRebuild });

    console.log();
    console.log(`Query: ${query}`);
    console.log('-'.repeat(80));
    console.log();

    // CozeLoop 根 span：一条 query 一个 run（禁用时直通）
    await withCozeLoopSpan(
        'rag-agent-cli',
        'run',
        async (span) => {
            setSpanInput(span, { query });
            await answerQuery(agent, query, span);
        },
    );
}

async function answerQuery(
    agent: Awaited<ReturnType<typeof createRagAgent>>,
    query: string,
    span: Span | null,
): Promise<void> {
    const run = await agent.streamEvents(
        { messages: [new HumanMessage(query)] },
        {
            version: 'v3',
            // CozeLoop：config 级回调兜底（与 LLM 实例级回调同一 handler，run_id 幂等）
            callbacks: getLangChainTracingCallbacks(),
        },
    );

    const COLORS = {
        reset: '\x1b[0m',
        green: '\x1b[32m',
    };

    // v3 的 messages 流会依次吐出中间轮次与子代理报告，与 API 路径口径对齐：
    // 只保留最后一段非空文本作为最终回答，避免根 span 记录整场转录
    let finalAnswer = '';
    let answerStarted = false;

    for await (const msg of run.messages) {
        if (!answerStarted) {
            console.log();
            console.log(`${COLORS.green}💬 Answer:${COLORS.reset}`);
            answerStarted = true;
        }
        let current = '';
        for await (const token of msg.text) {
            process.stdout.write(token);
            current += token;
        }
        if (current) finalAnswer = current;
    }

    console.log();
    console.log('-'.repeat(80));

    const state = await run.output;
    const finalMessage = state.messages.at(-1);
    if (!finalAnswer && finalMessage) {
        const fallbackText = finalMessage.text ?? finalMessage.content;
        if (fallbackText != null) {
            console.log(fallbackText);
            finalAnswer = String(fallbackText);
        } else {
            console.log('(no response)');
        }
    }
    setSpanOutput(span, { answer: truncateForSpan(finalAnswer) });
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        // CozeLoop：CLI 一次性进程，退出前强制上报缓冲中的 span
        shutdownCozeLoop();
    });
