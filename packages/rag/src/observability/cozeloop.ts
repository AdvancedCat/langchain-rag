// ============================================================================
// CozeLoop（扣子罗盘）tracer 初始化与开关
//
// - SDK 环境变量：COZELOOP_API_TOKEN / COZELOOP_WORKSPACE_ID / COZELOOP_API_BASE_URL
//   （SDK 自读）；本模块在调用 initialize 前先 gate——SDK 缺 workspaceId 会抛
//   PropertyUnprovidedError，未配置时必须保持完全 no-op（评测批跑零影响）。
// - 上报失败 SDK 内部吞错（仅打 [cozeloop] 日志），业务无感。
// 方案：docs/cozeloop-observability-plan.md §3.2
// ============================================================================

import { cozeLoopTracer } from '@cozeloop/ai';

const DEFAULT_API_BASE_URL = 'https://api.coze.cn';

let enabled = false;
let initialized = false;
let shutdownDone = false;

/** 当前是否启用（initCozeLoop 之前恒为 false，withCozeLoopSpan 等据此直通） */
export function isCozeLoopEnabled(): boolean {
    return enabled;
}

/**
 * 幂等初始化。默认 auto：token + workspace 齐备即启用；
 * COZELOOP_ENABLED 显式 true/false 覆盖（非法值直接抛错，与 config.ts 约定一致）。
 */
export function initCozeLoop(): boolean {
    if (initialized) return enabled;

    const token = process.env.COZELOOP_API_TOKEN;
    const workspaceId = process.env.COZELOOP_WORKSPACE_ID;
    const override = parseOptionalBooleanEnv('COZELOOP_ENABLED');
    // 显式 true 是强意图：缺凭据直接报配置错误（fail-fast，与 config.ts 约定一致），
    // 否则 initialize 会在更深的调用点抛出难定位的 PropertyUnprovidedError
    if (override === true && !(token && workspaceId)) {
        throw new Error(
            'COZELOOP_ENABLED=true requires COZELOOP_API_TOKEN and COZELOOP_WORKSPACE_ID to be set',
        );
    }
    const intent = override ?? Boolean(token && workspaceId);

    if (intent) {
        try {
            cozeLoopTracer.initialize({
                workspaceId: workspaceId as string,
                apiClient: {
                    baseURL: process.env.COZELOOP_API_BASE_URL ?? DEFAULT_API_BASE_URL,
                    token: token as string,
                },
                ultraLargeReport: parseBooleanEnv('COZELOOP_ULTRA_LARGE_REPORT', false),
            });
            // initialize 成功才置 enabled：SDK 配置错误会抛（PropertyUnprovidedError），
            // 若先置 true 再初始化，抛错后会留下 enabled=true/未初始化的半初始化态，
            // 业务路径 getTracer() 就会撞上未就绪的 SDK（契约：观测故障业务无感）
            enabled = true;
        } catch (error) {
            // 初始化失败：保持禁用并视为已初始化——重试不再反复半初始化，
            // 业务以禁用态直通（仅 [cozeloop] warn 提示配置问题）
            console.warn(
                `[cozeloop] initialize failed, tracing disabled: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    if (enabled) {
        const maskedWorkspace =
            workspaceId !== undefined && workspaceId.length > 8 ? `${workspaceId.slice(0, 8)}…` : (workspaceId ?? 'unknown');
        console.log(
            `🔭 CozeLoop tracing enabled (workspace=${maskedWorkspace}, ` +
                `baseURL=${process.env.COZELOOP_API_BASE_URL ?? DEFAULT_API_BASE_URL})`,
        );
    }
    initialized = true;
    return enabled;
}

/** 退出/优雅停机时强制刷盘（batch processor 定时上报，不 flush 会丢尾部 span） */
export async function shutdownCozeLoop(): Promise<void> {
    // 以 enabled 为准：禁用路径（含 initCozeLoop 已调用但未启用）不触碰 SDK
    if (!enabled || shutdownDone) return;
    shutdownDone = true;
    const warn = (op: string, error: unknown) =>
        console.warn(`[cozeloop] ${op} failed: ${error instanceof Error ? error.message : String(error)}`);
    // forceFlush/shutdown 返回 Promise：不 await 的话超时/网络 rejection 会以
    // unhandledRejection 逃逸崩掉进程（真实复现：flush 30s Timeout 在答案输出
    // 完、进程退出前炸 exit 1）；各自独立 catch，flush 失败也要走 shutdown
    try {
        await cozeLoopTracer.forceFlush();
    } catch (error) {
        warn('forceFlush', error);
    }
    try {
        await cozeLoopTracer.shutdown();
    } catch (error) {
        warn('shutdown', error);
    }
}

// ---------------------------------------------------------------------------
// env 解析（与 src/config.ts 的 parseBooleanEnv 同一约定：非法值抛错）
// ---------------------------------------------------------------------------

function parseOptionalBooleanEnv(name: string): boolean | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return undefined;
    return parseBooleanEnv(name, false);
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`Invalid boolean value for ${name}: "${raw}" (expected "true" | "false")`);
}
