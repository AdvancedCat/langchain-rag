export type QueryType =
    | 'concept'
    | 'api_usage'
    | 'comparison'
    | 'troubleshooting';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface GoldenQuery {
    id: string;
    query: string;
    type: QueryType;
    difficulty: Difficulty;
    expectedDocPaths: string[];
    expectedKeywords: string[];
}

export interface GoldenDataset {
    version: number;
    description: string;
    createdAt: string;
    queries: GoldenQuery[];
}

export interface RetrievedChunk {
    docPath: string;
    score: number;
    content: string;
    rank: number;
}

export interface QueryResult {
    query: GoldenQuery;
    retrieved: RetrievedChunk[];
    hitAtK: Record<number, boolean>;
    reciprocalRank: number;
    ndcgAtK: Record<number, number>;
    keywordHits: number;
    keywordTotal: number;
}

export interface EvalReport {
    totalQueries: number;
    hitRateAtK: Record<number, number>;
    mrr: number;
    ndcgAtK: Record<number, number>;
    avgKeywordRecall: number;
    byType: Record<QueryType, TypeBreakdown>;
    byDifficulty: Record<Difficulty, TypeBreakdown>;
    perQuery: QueryResult[];
    config: EvalConfig;
}

export interface TypeBreakdown {
    count: number;
    hitRateAtK: Record<number, number>;
    mrr: number;
    ndcgAtK: Record<number, number>;
}

export interface EvalConfig {
    fetchK: number;
    hitRateKs: number[];
    ndcgKs: number[];
    retrievalStrategy: string;
}
