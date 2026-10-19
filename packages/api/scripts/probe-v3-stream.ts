// ============================================================================
// P1 前置验证探针（方案 docs/api-service-plan.md §12 风险 1）
//
// 实测 deepagents streamEvents(v3) 的 ProtocolEvent 形状：channel 种类、
// namespace 归属（主代理 vs 子代理）、messages channel 的生命周期事件、
// tools/lifecycle payload、以及 deepseek-v4-flash 是否输出 reasoning。
//
// 用法：pnpm --filter @langchain-rag/api run probe:v3 "什么是langchain"
// ============================================================================

import '../src/env.js';

import { HumanMessage } from '@langchain/core/messages';
import { createRagAgent } from '@langchain-rag/rag';

const query = process.argv[2] ?? '什么是langchain';

function truncate(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
        return value.length > 120 ? `${value.slice(0, 120)}…(${value.length} chars)` : value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 4).map((item) => truncate(item, depth + 1));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
            out[key] = truncate(val, depth + 1);
        }
        return out;
    }
    return value;
}

async function main() {
    console.log(`query: ${query}`);
    const agent = await createRagAgent({});

    const run = await agent.streamEvents(
        { messages: [new HumanMessage(query)] },
        { version: 'v3' },
    );

    const counters = new Map<string, number>();
    for await (const ev of run) {
        const key = `${ev.method}`;
        counters.set(key, (counters.get(key) ?? 0) + 1);

        const summary = {
            seq: ev.seq,
            method: ev.method,
            ns: ev.params.namespace.join('/'),
            node: ev.params.node,
            data: truncate(ev.params.data),
        };
        console.log(JSON.stringify(summary));
    }

    console.log('--- channel 计数 ---');
    for (const [method, count] of counters) console.log(`${method}: ${count}`);

    const state = await run.output;
    console.log(`--- final state: ${state.messages.length} messages ---`);
    for (const msg of state.messages) {
        console.log(
            `[${msg.getType?.() ?? msg.constructor.name}] id=${String(msg.id)} ` +
                `content=${truncate(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))}`,
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
