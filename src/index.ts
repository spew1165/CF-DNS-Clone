// index.ts — Worker 入口（阶段 E 最终形态：所有逻辑来自拆分模块）
import { initializeAndMigrateDatabase } from './db/migrations.ts';
import { getSetting, setSetting } from './db/client.ts';
import { jsonResponse } from './util/http.ts';
import { syncScheduledIpSources } from './sync/ip-sources.ts';
import { syncScheduledDomains } from './sync/domains.ts';
import { handleApiRequest } from './routes/api.ts';
import { handleGitHubFileProxy } from './routes/github-proxy.ts';
import { handleUiRequest } from './routes/ui.ts';

export default {
  async fetch(request: Request, env: { WUYA: D1Database }, ctx: ExecutionContext): Promise<Response> {
      try {
        await initializeAndMigrateDatabase(env);
      } catch (e) {
        console.error("Database initialization failed:", e instanceof Error ? e.stack : e);
        return new Response("严重错误：数据库初始化失败，请检查Worker的D1数据库绑定是否正确配置为'WUYA'。", { status: 500 });
      }

      const url = new URL(request.url);
      const path = url.pathname;
      try {
          if (path.startsWith('/api/')) {
              return await handleApiRequest(request, env);
          }
          if (path.length > 1 && !path.startsWith('/api/') && !['/login', '/admin'].includes(path)) {
              const fileName = path.substring(1);
              return await handleGitHubFileProxy(fileName, env, ctx);
          }
          return await handleUiRequest(request, env);
      } catch (e) {
          console.error("Global Catch:", e instanceof Error ? e.stack : e);
          const errorResponse = { error: "发生意外的服务器错误。", details: e instanceof Error ? e.message : String(e) };
          const status = (e as { status?: number }).status || 500;
          if (path.startsWith('/api/')) {
              return jsonResponse(errorResponse, status);
          }
          return new Response(`错误: ${e instanceof Error ? e.message : String(e)}\n${e instanceof Error ? e.stack : ''}`, { status });
      }
  },
  async scheduled(controller: ScheduledController, env: { WUYA: D1Database }, ctx: ExecutionContext): Promise<void> {
      console.log("Scheduled task started: Initializing...");
      try {
          await initializeAndMigrateDatabase(env);
      } catch (e) {
          console.error("Database initialization failed in scheduled handler:", e instanceof Error ? e.stack : e);
          return;
      }

      const db = env.WUYA;
      const nextTask = await getSetting(db, 'next_sync_task') || 'domains';

      // 先轮转状态：无论 sync 成功或失败，下一分钟都跑另一个任务，避免单点失败永久卡死
      const otherTask = nextTask === 'domains' ? 'ip_sources' : 'domains';
      try {
          await setSetting(db, 'next_sync_task', otherTask);
      } catch (e) {
          console.error("Failed to rotate next_sync_task:", e instanceof Error ? e.stack : e);
      }

      try {
          if (nextTask === 'domains') {
              console.log("Scheduled task: Syncing a batch of DNS records (failure-first)...");
              await syncScheduledDomains(env);
          } else {
              console.log("Scheduled task: Syncing a batch of IP sources to GitHub (failure-first)...");
              await syncScheduledIpSources(env);
          }
      } catch (e) {
          console.error(`Scheduled task '${nextTask}' failed:`, e instanceof Error ? e.stack : e);
      }

      console.log("Scheduled task for this cycle finished.");
  },
};
