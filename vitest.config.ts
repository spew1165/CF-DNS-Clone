// vitest.config.ts — 阶段 F：vitest-pool-workers 测试配置
// 从 vitest/config 导入 defineProject，用于 multi-project 配置（R1 修订）
import { defineProject } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";

const migrationsPath = path.join(import.meta.dirname, "src/db/migrations");
const migrations = await readD1Migrations(migrationsPath);

export default defineProject({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        }),
    ],
    test: {
        globalSetup: ["./test/global-setup.ts"],
        setupFiles: ["./test/apply-migrations.ts"],
        // Q14 决策：单 worker 串行（避免 D1 SQLite 多进程锁）+ 文件级并行
        maxWorkers: 1,
        fileParallelism: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.ts"],
            exclude: ["src/ui/**", "src/index.js"],
            // 阶段 2 起始阈值：FIX-10 落地后逐步提升
            // 注意：vitest-pool-workers 沙箱下 v8 coverage 暂时不覆盖 worker 内部模块，
            // 现以 0% 起步跑通 setup；待 worker 引入 source maps 后逐步收紧。
            thresholds: {
                lines: 0,
                functions: 0,
                statements: 0,
                branches: 0,
            },
            // 沙箱下 v8 coverage 暂不覆盖：threshold 0 仍可能触发 vitest 内部零覆盖率警告，
            // 这里显式跳过阈值断言（保留 reporter 供人工查看）
            // 检查脚本可改用：vitest run --coverage --coverage.thresholds.lines=0
        },
    },
});
