# CF-DNS-Clone

Cloudflare Worker 单文件项目：域名克隆（DNS 同步） + IP 聚合（推送到 GitHub）。

## 关键事实

- **运行平台**：Cloudflare Workers（运行时，非 Node.js 构建）。本机**无** `package.json` / `wrangler.toml` / `tsconfig`，不要假定存在 npm 脚本或本地构建。
- **唯一入口文件**：`src/index.js`（约 1900 行），全部代码集中在此。导出对象含 `fetch` 与 `scheduled` 两个 handler。
- **唯一绑定**：`env.WUYA` → D1 数据库。**变量名必须为 `WUYA`（全大写）**，参见 `src/index.js:124`。缺失会返回 `500`。
- **路由**（`src/index.js:13-29`）：
    - `/api/*` → `handleApiRequest`
    - 其它非根路径（除 `/login`、`/admin`）→ `handleGitHubFileProxy`（订阅器直读）
    - `/`、`/login`、`/admin` → `handleUiRequest`
- **定时任务**：必须配置 Cron `* * * * *`（每分钟）。通过 `setting:next_sync_task` 在 `domains` ↔ `ip_sources` 两种批任务间轮转，每批处理 `BATCH_SIZE=5` 条且失败优先（`src/index.js:34-70`）。

## 本地开发

仓库**未配置** `wrangler dev` / 构建脚本。日常修改流程：

1. 直接编辑 `src/index.js`。
2. 在 Cloudflare 控制台 → Worker → _Edit Code_ → 粘贴覆盖 → _Deploy_。
3. 通过 `/admin` 后台 + 数据库 D1 控制台联调。

如需引入 `wrangler` 本地调试，应作为新增能力处理（先与维护者商量），而非假设已存在。

## 风格与约定

- 注释、错误消息、`console.log` 文案使用中文（已存在于代码内）。
- 缩进 4 空格、LF 行尾、UTF-8（见 `.editconfig`）。
- 不引入新依赖 / 新构建工具，除非任务明确要求。

## 不要做的事

- 不要新增 `package.json` 或迁出 `src/index.js`——本项目设计就是单文件交付。
- 不要修改 `env.WUYA` 这个绑定名，控制台配置依赖它。
- 不要提议把数据库绑定名改成别的——README 已写明用户须设为 `WUYA`。
- 不要触碰 `.claude/` 内容（含 `plans/`、`skills/`、`scheduled_tasks.lock`），已被 `.gitignore` 排除。
- 不要在未经确认的情况下，向仓库提交任何 Secrets（CF API Token、GitHub Token）。

## 仓库结构

```
.
├── README.md            # 用户面向的部署教程
├── src/
│   └── index.js         # 全部逻辑（fetch + scheduled handler）
├── IMG/、IMG-1/、img/、SRC-1/
│                        # 教程截图，按 README 直接引用
├── .editconfig          # 4 空格 / LF / UTF-8
├── .gitignore           # 已排除 .claude/、.trae/、node_modules/、.wrangler/、dist/
├── .gitattributes
└── .idea/、.trae/
                         # 本地状态，按 .gitignore 排除或不参与构建
```

## 相关资源

- `README.md` 中的“网页部署指南”章节是面向最终用户的部署 4 步流程，新功能应当与该流程向后兼容。
