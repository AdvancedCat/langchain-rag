import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RetrievedChunk } from '../shared/types.js';
import type { FaithfulnessResult, ClaimVerdict } from './types.js';
import { callLLMJson } from './llm-json.js';

const ClaimsSchema = z.object({
    claims: z.array(z.string()),
});

const VerdictsSchema = z.object({
    verdicts: z.array(
        z.object({
            claim: z.string(),
            supported: z.boolean(),
            reason: z.string(),
        }),
    ),
});

const ABSTENTION_PHRASES = [
    '无法找到',
    '无法回答',
    '没有相关信息',
    '没有提到',
    "i don't know",
    'i do not know',
    'cannot answer',
    'not mentioned',
    'no information',
    '无法确定',
    '没有找到',
    'does not contain',
    "don't have enough information",
];

export function isAbstention(answer: string): boolean {
    const lower = answer.toLowerCase().trim();
    return ABSTENTION_PHRASES.some((phrase) => lower.includes(phrase.toLowerCase()));
}

function formatContext(chunks: RetrievedChunk[]): string {
    return chunks
        .map((chunk, i) => `[Excerpt ${i + 1}]\n${chunk.content}`)
        .join('\n\n---\n\n');
}

export async function evaluateFaithfulness(
    llm: BaseChatModel,
    answer: string,
    chunks: RetrievedChunk[],
): Promise<FaithfulnessResult> {
    if (isAbstention(answer)) {
        return {
            claims: [],
            verdicts: [],
            supportedCount: 0,
            totalCount: 0,
            score: 1.0,
        };
    }

    const context = formatContext(chunks);

    const claimPrompt = `Break down the following answer into at most 8 atomic factual claims. Each claim should be a single, verifiable statement.

Return ONLY a JSON object in this exact format:
{"claims": ["claim 1", "claim 2", ...]}

If the answer contains no verifiable claims (e.g. it is a refusal or greeting), return {"claims": []}.

Answer:
${answer}`;

    const claimResult = await callLLMJson(llm, claimPrompt, ClaimsSchema);
    const claims: string[] = claimResult.claims ?? [];

    if (claims.length === 0) {
        return {
            claims: [],
            verdicts: [],
            supportedCount: 0,
            totalCount: 0,
            score: 1.0,
        };
    }

    const verdictPrompt = `You are a fact-checker. For each claim below, determine whether it is directly supported by the provided context.

A claim is "supported" if the context explicitly states or clearly entails it. A claim is NOT supported if it requires external knowledge, makes assumptions beyond the context, or contradicts the context.

Return ONLY a JSON object in this exact format:
{"verdicts": [{"claim": "...", "supported": true/false, "reason": "brief citation or contradiction"}]}

Keep each reason under 15 words.

Context:
${context}

Claims to verify:
${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;

    const verdictResult = await callLLMJson(llm, verdictPrompt, VerdictsSchema);

    const verdicts: ClaimVerdict[] = (verdictResult.verdicts ?? []).map((v) => ({
        claim: v.claim,
        supported: v.supported,
        reason: v.reason,
    }));

    const supportedCount = verdicts.filter((v) => v.supported).length;
    const totalCount = verdicts.length;

    return {
        claims,
        verdicts,
        supportedCount,
        totalCount,
        score: totalCount > 0 ? supportedCount / totalCount : 1.0,
    };
}
