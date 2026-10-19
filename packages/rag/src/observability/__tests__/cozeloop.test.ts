// ============================================================================
// initCozeLoop gate 行为：未配置 no-op、auto 启用、显式覆盖、初始化失败降级禁用、
// 幂等、shutdown 刷盘
//（方案 §3.2；@cozeloop/ai 全 mock，不触真实服务）
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cozeLoopTracer } from '@cozeloop/ai';

vi.mock('@cozeloop/ai', () => ({
    cozeLoopTracer: {
        initialize: vi.fn(),
        forceFlush: vi.fn(),
        shutdown: vi.fn(),
        traceable: vi.fn(),
        getTracer: vi.fn(),
        setInput: vi.fn(),
        setOutput: vi.fn(),
        setError: vi.fn(),
        setTags: vi.fn(),
    },
    SpanKind: {
        PromptHub: 'prompt_hub',
        PromptTemplate: 'prompt',
        Model: 'model',
        Retriever: 'retriever',
        Tool: 'tool',
    },
    COZELOOP_TRACE_BASIC_TAGS: {
        SPAN_NAME: 'cozeloop_span_name',
        SPAN_TYPE: 'cozeloop_span_type',
        SPAN_INPUT: 'cozeloop_span_input',
        SPAN_OUTPUT: 'cozeloop_span_output',
    },
    COZELOOP_TRACE_BUSINESS_TAGS: {},
}));

const ENV_KEYS = [
    'COZELOOP_ENABLED',
    'COZELOOP_API_TOKEN',
    'COZELOOP_WORKSPACE_ID',
    'COZELOOP_API_BASE_URL',
    'COZELOOP_ULTRA_LARGE_REPORT',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
        savedEnv.set(key, process.env[key]);
        delete process.env[key];
    }
    vi.mocked(cozeLoopTracer.initialize).mockClear();
    vi.mocked(cozeLoopTracer.forceFlush).mockClear();
    vi.mocked(cozeLoopTracer.shutdown).mockClear();
});

afterEach(() => {
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

/** 每个用例重新加载真实 cozeloop.ts（模块级 enabled/initialized 状态需重置） */
async function loadModule() {
    return import('../cozeloop.js');
}

describe('initCozeLoop', () => {
    it('未配置 token/workspace 时禁用且不调用 initialize（评测批跑零影响）', async () => {
        const mod = await loadModule();
        expect(mod.initCozeLoop()).toBe(false);
        expect(mod.isCozeLoopEnabled()).toBe(false);
        expect(cozeLoopTracer.initialize).not.toHaveBeenCalled();
    });

    it('token + workspace 齐备时 auto 启用并传入解析后的配置', async () => {
        process.env.COZELOOP_API_TOKEN = 'pat-xxx';
        process.env.COZELOOP_WORKSPACE_ID = 'ws-1234567890';
        const mod = await loadModule();
        expect(mod.initCozeLoop()).toBe(true);
        expect(mod.isCozeLoopEnabled()).toBe(true);
        expect(cozeLoopTracer.initialize).toHaveBeenCalledWith({
            workspaceId: 'ws-1234567890',
            apiClient: { baseURL: 'https://api.coze.cn', token: 'pat-xxx' },
            ultraLargeReport: false,
        });
    });

    it('自定义 COZELOOP_API_BASE_URL 与 ultraLargeReport 透传', async () => {
        process.env.COZELOOP_API_TOKEN = 'pat';
        process.env.COZELOOP_WORKSPACE_ID = 'ws';
        process.env.COZELOOP_API_BASE_URL = 'http://localhost:8888';
        process.env.COZELOOP_ULTRA_LARGE_REPORT = 'true';
        const mod = await loadModule();
        expect(mod.initCozeLoop()).toBe(true);
        expect(vi.mocked(cozeLoopTracer.initialize).mock.calls[0][0]).toMatchObject({
            apiClient: { baseURL: 'http://localhost:8888' },
            ultraLargeReport: true,
        });
    });

    it('COZELOOP_ENABLED=false 强制关闭（即使凭据齐备）', async () => {
        process.env.COZELOOP_API_TOKEN = 'pat';
        process.env.COZELOOP_WORKSPACE_ID = 'ws';
        process.env.COZELOOP_ENABLED = 'false';
        const mod = await loadModule();
        expect(mod.initCozeLoop()).toBe(false);
        expect(cozeLoopTracer.initialize).not.toHaveBeenCalled();
    });

    it('COZELOOP_ENABLED=true 缺凭据时 fail-fast 抛配置错误', async () => {
        process.env.COZELOOP_ENABLED = 'true';
        const mod = await loadModule();
        expect(() => mod.initCozeLoop()).toThrow(/COZELOOP_ENABLED=true requires/);
        expect(cozeLoopTracer.initialize).not.toHaveBeenCalled();
    });

    it('COZELOOP_ENABLED 非法值抛错（与 config.ts 布尔解析约定一致）', async () => {
        process.env.COZELOOP_ENABLED = 'yes';
        const mod = await loadModule();
        expect(() => mod.initCozeLoop()).toThrow(/COZELOOP_ENABLED/);
    });

    it('initialize 抛错时保持禁用且视为已初始化（业务无感，重试不反复半初始化）', async () => {
        process.env.COZELOOP_API_TOKEN = 'pat';
        process.env.COZELOOP_WORKSPACE_ID = 'ws';
        vi.mocked(cozeLoopTracer.initialize).mockImplementationOnce(() => {
            throw new Error('PropertyUnprovidedError: workspaceId');
        });
        const mod = await loadModule();
        expect(() => mod.initCozeLoop()).not.toThrow();
        expect(mod.initCozeLoop()).toBe(false);
        expect(mod.isCozeLoopEnabled()).toBe(false);
        expect(cozeLoopTracer.initialize).toHaveBeenCalledTimes(1);
    });

    it('重复调用幂等：initialize 只触发一次', async () => {
        process.env.COZELOOP_API_TOKEN = 'pat';
        process.env.COZELOOP_WORKSPACE_ID = 'ws';
        const mod = await loadModule();
        mod.initCozeLoop();
        mod.initCozeLoop();
        expect(cozeLoopTracer.initialize).toHaveBeenCalledTimes(1);
    });
});

describe('shutdownCozeLoop', () => {
    it('未初始化时为 no-op', async () => {
        const mod = await loadModule();
        mod.shutdownCozeLoop();
        expect(cozeLoopTracer.forceFlush).not.toHaveBeenCalled();
        expect(cozeLoopTracer.shutdown).not.toHaveBeenCalled();
    });

    it('initCozeLoop 已调用但未启用时同样 no-op（不得触碰未初始化的 SDK tracer）', async () => {
        const mod = await loadModule();
        expect(mod.initCozeLoop()).toBe(false);
        mod.shutdownCozeLoop();
        expect(cozeLoopTracer.forceFlush).not.toHaveBeenCalled();
        expect(cozeLoopTracer.shutdown).not.toHaveBeenCalled();
    });

    it('初始化后 forceFlush + shutdown 各一次，重复调用 no-op', async () => {
        process.env.COZELOOP_API_TOKEN = 'pat';
        process.env.COZELOOP_WORKSPACE_ID = 'ws';
        const mod = await loadModule();
        mod.initCozeLoop();
        await mod.shutdownCozeLoop();
        await mod.shutdownCozeLoop();
        expect(cozeLoopTracer.forceFlush).toHaveBeenCalledTimes(1);
        expect(cozeLoopTracer.shutdown).toHaveBeenCalledTimes(1);
    });

    it('flush 异步失败被吞掉且 shutdown 仍执行（teardown 不跳过、不以 unhandledRejection 逃逸）', async () => {
        process.env.COZELOOP_API_TOKEN = 'pat';
        process.env.COZELOOP_WORKSPACE_ID = 'ws';
        vi.mocked(cozeLoopTracer.forceFlush).mockRejectedValueOnce(new Error('flush timeout'));
        const mod = await loadModule();
        mod.initCozeLoop();
        await expect(mod.shutdownCozeLoop()).resolves.toBeUndefined();
        expect(cozeLoopTracer.shutdown).toHaveBeenCalledTimes(1);
    });
});
