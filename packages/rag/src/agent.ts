import 'dotenv/config';

import { HumanMessage } from '@langchain/core/messages';
import { EXAMPLE_QUERY } from './config.js';
import { buildVectorStore } from './ingestion/index.js';
import { createRagAgent } from './retrieval/index.js';

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

    const run = await agent.streamEvents(
        { messages: [new HumanMessage(query)] },
        { version: 'v3' },
    );

    const COLORS = {
        reset: '\x1b[0m',
        green: '\x1b[32m',
    };

    let finalAnswer = '';
    let answerStarted = false;

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
