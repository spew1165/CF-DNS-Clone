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
      await initializeAndMigrateDatabase(env);

      const db = env.WUYA;
      const nextTask = await getSetting(db, 'next_sync_task') || 'domains';

      if (nextTask === 'domains') {
          console.log("Scheduled task: Syncing a batch of DNS records (failure-first)...");
          await syncScheduledDomains(env);
          await setSetting(db, 'next_sync_task', 'ip_sources');
      } else {
          console.log("Scheduled task: Syncing a batch of IP sources to GitHub (failure-first)...");
          await syncScheduledIpSources(env);
          await setSetting(db, 'next_sync_task', 'domains');
      }

      console.log("Scheduled task for this cycle finished.");
  },
};
