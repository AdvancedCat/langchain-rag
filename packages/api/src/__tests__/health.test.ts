import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// /ready 依赖 agent 构建与 Redis 连通性——单测里全部 mock，
// 真实链路由冒烟（pnpm serve + curl /ready）覆盖。

const agentStatus = vi.hoisted(() => ({ value: 'idle' as string }));
const redisOk = vi.hoisted(() => ({ value: false }));
const warmupSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../agentService.js', () => ({
    getAgentState: () => ({ status: agentStatus.value }),
    warmupAgent: warmupSpy,
}));

vi.mock('../redis.js', () => ({
    pingRedis: () => Promise.resolve(redisOk.value),
    getRedis: vi.fn(),
    closeRedis: vi.fn(async () => {}),
}));

import { createApp } from '../app.js';

let server: Server | undefined;

afterEach(async () => {
    agentStatus.value = 'idle';
    redisOk.value = false;
    warmupSpy.mockClear();
    if (server) {
        server.close();
        await once(server, 'close');
        server = undefined;
    }
});

async function listen(): Promise<string> {
    const { app } = createApp();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { address, port } = server.address() as AddressInfo;
    return `http://${address}:${port}`;
}

describe('GET /health', () => {
    it('进程存活即 200，不触发 agent/redis 探测', async () => {
        const base = await listen();
        const res = await fetch(`${base}/health`);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; version: string; uptimeSeconds: number };
        expect(body.status).toBe('ok');
        expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(body.uptimeSeconds).toBeTypeOf('number');
        expect(warmupSpy).not.toHaveBeenCalled();
    });
});

describe('GET /ready', () => {
    it('agent 未就绪时 503，且探针触发 warmup 重试', async () => {
        const base = await listen();
        const res = await fetch(`${base}/ready`);

        expect(res.status).toBe(503);
        const body = (await res.json()) as { status: string; checks: { agent: string; redis: string } };
        expect(body.status).toBe('not_ready');
        expect(body.checks.agent).toBe('idle');
        expect(body.checks.redis).toBe('down');
        expect(warmupSpy).toHaveBeenCalledTimes(1);
    });

    it('agent ready 且 redis 可达时 200', async () => {
        agentStatus.value = 'ready';
        redisOk.value = true;
        const base = await listen();
        const res = await fetch(`${base}/ready`);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; checks: { agent: string; redis: string } };
        expect(body.status).toBe('ready');
        expect(body.checks).toEqual({ agent: 'ready', redis: 'ok' });
        // ready 态不应重复触发 warmup
        expect(warmupSpy).not.toHaveBeenCalled();
    });
});

describe('基础中间件', () => {
    it('未知路由返回统一错误体', async () => {
        const base = await listen();
        const res = await fetch(`${base}/no-such-route`);

        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('not_found');
    });

    it('白名单内 Origin 的预检请求返回 204 与 CORS 头', async () => {
        const base = await listen();
        const res = await fetch(`${base}/health`, {
            method: 'OPTIONS',
            headers: { Origin: 'http://localhost:5173' },
        });

        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });

    it('白名单外 Origin 不带 CORS 头', async () => {
        const base = await listen();
        const res = await fetch(`${base}/health`, {
            headers: { Origin: 'http://evil.example' },
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
});
