import { OpenAIEmbeddings } from '@langchain/openai';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { EmbeddingConfig } from './config.js';

export function getEmbeddingConfig(): EmbeddingConfig {
    const model = process.env.QWEN_EMBEDDING_MODEL ?? 'qwen3.7-text-embedding';
    const dimensions = process.env.QWEN_EMBEDDING_DIMENSIONS
        ? Number(process.env.QWEN_EMBEDDING_DIMENSIONS)
        : undefined;
    return {
        model,
        dimensions,
    };
}

export function createEmbeddings(): EmbeddingsInterface {
    const config = getEmbeddingConfig();
    if (!process.env.DASHSCOPE_API_KEY) {
        throw new Error(
            'DASHSCOPE_API_KEY is required. Please set it in your .env file.',
        );
    }

    console.log('🧠 Using Qianwen embedding:', config.model);
    return new OpenAIEmbeddings({
        apiKey: process.env.DASHSCOPE_API_KEY,
        configuration: {
            baseURL:
                process.env.DASHSCOPE_BASE_URL ??
                'https://dashscope.aliyuncs.com/compatible-mode/v1',
        },
        model: config.model,
        batchSize: 20,
        ...(config.dimensions ? { dimensions: config.dimensions } : {}),
    });
}
