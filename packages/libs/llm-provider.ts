import "dotenv/config";

import { ChatOpenAI } from "@langchain/openai";
import type { Callbacks } from "@langchain/core/callbacks/manager";

// ============================================================================
// DeepSeek chat model factory
//
// DeepSeek exposes an OpenAI-compatible Chat Completions API, so we reuse
// ChatOpenAI and point its baseURL at the DeepSeek endpoint.
//
// Usage:
//   import { getLLM } from "../libs/llm-provider.js";
//   const agent = createDeepAgent({ model: getLLM(), ... });
//
// Required env: DEEPSEEK_API_KEY
// Optional env: LLM_MODEL (default deepseek-v4-flash),
//               DEEPSEEK_BASE_URL, LLM_TEMPERATURE, LLM_MAX_TOKENS
// ============================================================================

export interface GetLLMOptions {
  /**
   * Instance-level callbacks fired on EVERY invocation of the returned model —
   * including direct `llm.invoke()` calls inside tool bodies (query rewrite,
   * multi-query), which config-level callbacks (streamEvents options) cannot
   * reach. Used to attach the CozeLoop observability handler.
   */
  callbacks?: Callbacks;
}

export function getLLM(options: GetLLMOptions = {}): ChatOpenAI {
  const modelName = process.env.LLM_MODEL ?? "deepseek-v4-flash";
  const apiKey = requireKey("DEEPSEEK_API_KEY");
  const temperature = readTemperature();
  const maxTokens = readMaxTokens() ?? 4096;

  return new ChatOpenAI({
    model: modelName,
    apiKey,
    configuration: {
      baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    },
    temperature,
    maxTokens,
    timeout: 60000,
    callbacks: options.callbacks,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readTemperature(): number {
  const raw = process.env.LLM_TEMPERATURE;
  if (raw === undefined) return 0.7;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0.7;
}

function readMaxTokens(): number | undefined {
  const raw = process.env.LLM_MAX_TOKENS;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function requireKey(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Please set it in your .env file.`,
    );
  }
  return value;
}
