export interface RerankResult {
    index: number;
    relevanceScore: number;
}

export interface Reranker {
    rank(query: string, documents: string[], topN: number): Promise<RerankResult[]>;
}

export interface DashScopeRerankerConfig {
    apiKey: string;
    model: string;
    rerankUrl: string;
    timeoutMs?: number;
}

export function createDashScopeReranker(config: DashScopeRerankerConfig): Reranker {
    const { apiKey, model, rerankUrl, timeoutMs = 10_000 } = config;

    return {
        async rank(query: string, documents: string[], topN: number): Promise<RerankResult[]> {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetch(rerankUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model,
                        input: { query, documents },
                        parameters: { top_n: topN, return_documents: false },
                    }),
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const errBody = await response.json().catch(() => ({}));
                    const message = (errBody as { message?: string }).message ?? response.statusText;
                    const code = (errBody as { code?: string }).code ?? 'HTTP_ERROR';
                    throw new Error(`Rerank API ${response.status} [${code}]: ${message}`);
                }

                const data = await response.json() as {
                    output?: { results?: Array<{ index: number; relevance_score: number }> };
                };

                const results = data.output?.results ?? [];
                return results.map((r) => ({
                    index: r.index,
                    relevanceScore: r.relevance_score,
                }));
            } finally {
                clearTimeout(timeoutId);
            }
        },
    };
}
