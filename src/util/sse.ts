// sse.ts — SSE（Server-Sent Events）日志流响应
// 从 index.legacy.js 提取（原 1450-1479 行）

import { beijingTimeLog } from './log.ts';

/**
 * 创建 SSE 日志流响应：把 logFunction 的执行过程实时推送给客户端
 * @param logFunction 异步函数，接收 log 回调用于输出日志
 */
export function createLogStreamResponse(logFunction: (log: (message: string) => void) => Promise<void>): Response {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const log = (message: string) => {
        const logMsg = beijingTimeLog(message);
        try {
            writer.write(encoder.encode(`data: ${logMsg}\n\n`));
        } catch (e) {
            console.error("Failed to write to stream:", e);
        }
    };

    (async () => {
        try {
            await logFunction(log);
        } catch (e) {
            log(`[FATAL_ERROR] ${e instanceof Error ? e.message : String(e)}`);
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
