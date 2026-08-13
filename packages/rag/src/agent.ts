import 'dotenv/config';

import { HumanMessage } from '@langchain/core/messages';
import { EXAMPLE_QUERY } from './config.js';
import { buildVectorStore } from './ingestion/index.js';
import { createRagAgent } from './retrieval/index.js';

async function main() {
    const args = process.argv.slice(2);
    const isIndexOnly = args.includes('--index-only');
    const forceRebuild = args.includes('--rebuild');

    console.log('='.repeat(80));
    console.log('Deep Agents RAG - Documentation Q&A Agent');
    console.log('='.repeat(80));
    console.log();

    if (isIndexOnly) {
        await buildVectorStore(forceRebuild);
        console.log('Indexing complete.');
        return;
    }

    const agent = await createRagAgent(forceRebuild);

    console.log();
    console.log(`Query: ${EXAMPLE_QUERY}`);
    console.log('-'.repeat(80));
    console.log();

    const run = await agent.streamEvents(
        { messages: [new HumanMessage(EXAMPLE_QUERY)] },
        { version: 'v3' },
    );

    const COLORS = {
        reset: '\x1b[0m',
        dim: '\x1b[2m',
        cyan: '\x1b[36m',
        yellow: '\x1b[33m',
        magenta: '\x1b[35m',
        green: '\x1b[32m',
        red: '\x1b[31m',
    };

    const indent = (level: number) => '  '.repeat(level);

    let finalAnswer = '';
    let answerStarted = false;

    await Promise.all(
        [
            (async () => {
                for await (const msg of run.messages) {
                    if (!answerStarted) {
                        console.log();
                        console.log(`${COLORS.green}💬 Answer:${COLORS.reset}`);
                        answerStarted = true;
                    }
                    for await (const token of msg.text) {
                        process.stdout.write(token);
                        finalAnswer += token;
                    }
                }
            })(),

            false &&
                (async () => {
                    for await (const call of run.toolCalls) {
                        console.log();
                        console.log(
                            `${COLORS.yellow}🔧 Tool Call: ${call.name}${COLORS.reset}`,
                        );
                        console.log(
                            `${COLORS.dim}${indent(1)}Input: ${JSON.stringify(
                                call.input,
                                null,
                                2,
                            )
                                .split('\n')
                                .join(`\n${indent(1)}`)}${COLORS.reset}`,
                        );
                        const output = await call.output;
                        const outputStr =
                            typeof output === 'string'
                                ? output
                                : JSON.stringify(output, null, 2);
                        const preview =
                            outputStr.length > 500
                                ? outputStr.slice(0, 500) + '...'
                                : outputStr;
                        console.log(
                            `${COLORS.dim}${indent(1)}Output: ${preview.split('\n').join(`\n${indent(1)}`)}${COLORS.reset}`,
                        );
                    }
                })(),

            false &&
                (async () => {
                    for await (const sub of run.subagents) {
                        console.log();
                        console.log(
                            `${COLORS.magenta}🤖 Subagent: ${sub.name}${COLORS.reset}`,
                        );
                        for await (const msg of sub.messages) {
                            for await (const token of msg.text) {
                                process.stdout.write(
                                    `${COLORS.magenta}${indent(1)}${token}${COLORS.reset}`,
                                );
                            }
                        }
                        console.log();
                    }
                })(),
        ].filter(Boolean),
    );

    console.log();
    console.log('-'.repeat(80));

    const state = await run.output;
    const finalMessage = state.messages.at(-1);
    if (!finalAnswer && finalMessage) {
        console.log(
            finalMessage.text ?? finalMessage.content ?? '(no response)',
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
