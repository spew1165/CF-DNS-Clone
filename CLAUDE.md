# CF-DNS-Clone

Cloudflare Worker 项目：域名克隆（DNS 同步） + IP 聚合（推送到 GitHub）。

## 关键事实

- **运行平台**：Cloudflare Workers（运行时 workerd）。开发工具链：pnpm 11 + Node ≥ 22（本地 24）+ wrangler 4 + TypeScript strict + vitest。
- **唯一入口**：`src/index.ts`（约 60 行），导出 `fetch` 与 `scheduled` 两个 handler，组装 8 个模块。
- **唯一绑定**：`env.WUYA` → D1 数据库。**变量名必须为 `WUYA`（全大写）**，参见 `src/index.ts:12`。缺失会返回 `500`。
- **路由**（`src/index.ts:20-39`）：
    - `/api/*` → `handleApiRequest`（`src/routes/api.ts`）
    - 其它非根路径（除 `/login`、`/admin`）→ `handleGitHubFileProxy`（订阅器直读，`src/routes/github-proxy.ts`）
    - `/`、`/login`、`/admin` → `handleUiRequest`（`src/routes/ui.ts`）
- **定时任务**：必须配置 Cron `* * * * *`（每分钟）。通过 `setting:next_sync_task` 在 `domains` ↔ `ip_sources` 两种批任务间轮转，每批处理 `BATCH_SIZE=5` 条且失败优先（`src/index.ts:41-59`）。

## 本地开发

```bash
pnpm install    # 安装依赖（首次）
pnpm dev        # wrangler dev 起本地 workerd（默认 8787 端口）
pnpm test       # vitest-pool-workers 全套测试（23 用例，workerd 内跑）
pnpm typecheck  # tsc --noEmit 严格模式检查
pnpm deploy     # CLI 部署（需先在 wrangler.jsonc 填入 D1 database_id）
pnpm cf-typegen # 重新生成 worker-configuration.d.ts（gitignore）
```

- 本地 D1 数据在 `.wrangler/state/d1/`，可用 `wrangler d1 execute --local` 查询。
- 测试的 D1 迁移在 `src/db/migrations/`（`.sql` 文件），运行时建表由 `initializeAndMigrateDatabase` 幂等 DDL 完成。
- 仓库保留 `src/index.js`（1927 行单文件，git tag `v0.x-pre-split` 可回溯）——README 网页部署 4 步流程仍粘贴该文件，与模块化代码并存不冲突。

## 文案三档规则（强制）

- **中文**：`console.*` / `throw new Error(msg)` / UI 模板字符串 / 用户可见的 API 错误消息
- **英文**：函数名 / 变量名 / 类型名 / import 路径 / 测试断言文本
- **英文**：代码注释中解释"为什么这样做"的元说明可保留英文（一句话内）

## 风格与约定

- 缩进 4 空格、LF 行尾、UTF-8（见 `.editorconfig`）。
- 不引入新依赖 / 新构建工具，除非任务明确要求。
- KISS：避免过度工程化；改代码只碰必须碰的。

## 不要做的事

- 不要修改 `env.WUYA` 这个绑定名，控制台配置依赖它。
- 不要提议把数据库绑定名改成别的——README 已写明用户须设为 `WUYA`。
- 不要删除 `src/index.js`——README 网页部署 4 步流程依赖它。
- 不要触碰 `.claude/` 内容（含 `plans/`、`skills/`、`scheduled_tasks.lock`），已被 `.gitignore` 排除。
- 不要在未经确认的情况下，向仓库提交任何 Secrets（CF API Token、GitHub Token）。
- 不要在 `wrangler.jsonc` 提交真实 `database_id`——用 `REPLACE_WITH_YOUR_D1_ID` 占位符（`predeploy` 脚本会拦截未替换的部署）。

## 仓库结构

```
.
├── README.md            # 用户面向的部署教程（网页 4 步 + 开发者模式）
├── docs/plan/           # 改造计划 v2 + 决策日志
├── src/
│   ├── index.ts         # Worker 入口（fetch + scheduled 组装）
│   ├── index.js         # 单文件版（网页部署路径，1927 行，保持只读）
│   ├── db/              # client.ts（D1 封装）+ migrations.ts（幂等建表）+ migrations/*.sql（测试迁移）
│   ├── routes/          # api.ts / ui.ts / github-proxy.ts
│   ├── sync/            # domains.ts / ip-sources.ts / github.ts
│   ├── ui/              # templates.js（UI 模板，纯 JS，tsc 不参与）
│   └── util/            # auth / http / log / sse / fetch / cf
├── test/                # vitest-pool-workers 测试（7 文件 23 用例）
├── vitest.config.ts     # 测试配置（cloudflareTest + D1 迁移绑定）
├── wrangler.jsonc       # Worker 配置（compatibility_date 2026-01-15，keep_vars）
├── package.json         # 脚本：dev / test / typecheck / deploy / cf-typegen
├── .editorconfig        # 4 空格 / LF / UTF-8
├── .gitignore
└── .idea/、.trae/
                         # 本地状态，按 .gitignore 排除或不参与构建
```

## 相关资源

- `README.md` 中的"网页部署指南"章节是面向最终用户的部署 4 步流程（粘贴 `src/index.js`），新功能应当与该流程向后兼容。
- `docs/plan/refactoring-plan-v2.md` 是架构改造总设计图；`docs/plan/refactoring-decisions.md` 是决策日志（含 B1-B4 隐含修正、R1-R3 修订）。
