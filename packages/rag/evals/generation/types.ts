import type { GoldenQuery, RetrievedChunk, QueryType, Difficulty } from '../types.js';

export interface GenEvalConfig {
    topK: number;
    fetchK: number;
    numGeneratedQuestions: number;
    retrievalStrategy: string;
    abstentionThreshold: number;
}

export interface ClaimVerdict {
    claim: string;
    supported: boolean;
    reason: string;
}

export interface FaithfulnessResult {
    claims: string[];
    verdicts: ClaimVerdict[];
    supportedCount: number;
    totalCount: number;
    score: number;
}

export interface RelevanceResult {
    generatedQuestions: string[];
    similarities: number[];
    score: number;
}

export interface GenQueryResult {
    query: GoldenQuery;
    retrieved: RetrievedChunk[];
    generatedAnswer: string;
    faithfulness: FaithfulnessResult;
    relevance: RelevanceResult;
    generationAbstained: boolean;
    retrievalAbstained: boolean;
    abstentionCorrect: boolean;
    topScore: number;
}

export interface GenTypeBreakdown {
    count: number;
    avgFaithfulness: number;
    avgRelevance: number;
}

export interface GenEvalReport {
    evaluatedAt: string;
    totalQueries: number;
    answerableCount: number;
    unanswerableCount: number;
    avgFaithfulness: number;
    avgRelevance: number;
    abstentionRate: number;
    answerableFaithfulness: number;
    answerableRelevance: number;
    byType: Record<QueryType, GenTypeBreakdown>;
    byDifficulty: Record<Difficulty, GenTypeBreakdown>;
    perQuery: GenQueryResult[];
    config: GenEvalConfig;
}
