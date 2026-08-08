// sse.ts — SSE（Server-Sent Events）日志流响应
// 从 index.legacy.js 提取（原 1450-1479 行）

import { beijingTimeLog } from './log.ts';

/**
 * 创建 SSE 日志流响应：把 logFunction 的执行过程实时推送给客户端
 * @param logFunction 异步函数，接收 log 回调用于输出日志
 * @param signal 客户端断开信号（AbortSignal）—— 可选；触发后立即终止后端任务
 */
export function createLogStreamResponse(logFunction: (log: (message: string) => void) => Promise<void>, signal?: AbortSignal): Response {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let aborted = false;
    const log = (message: string) => {
        if (aborted) return;
        const logMsg = beijingTimeLog(message);
        // writer.write 返回 Promise，不能被同步 try/catch 捕获；用 .catch 链式处理
        writer.write(encoder.encode(`data: ${logMsg}\n\n`)).catch(e => console.error("Failed to write to stream:", e instanceof Error ? e.message : e));
    };

    if (signal) {
        signal.addEventListener('abort', () => {
            aborted = true;
            writer.close().catch(() => {});
        }, { once: true });
    }

    (async () => {
        try {
            await logFunction(log);
        } catch (e) {
            if (!aborted) log(`[FATAL_ERROR] ${e instanceof Error ? e.message : String(e)}`);
            console.error("Streaming log function error:", e instanceof Error ? e.stack : e);
        } finally {
            try {
                await writer.close();
            } catch (e) {}
        }
    })();

    return new Response(readable, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
    });
}
