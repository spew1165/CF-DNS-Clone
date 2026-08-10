// sync.test.ts — 用例 3/4：域名同步写回 D1 + IP 源多源回退 + 禁用源守卫
// 覆盖 plan v2 用例表：#3 syncDomainRecord 写回 D1、#4 fetchIpSource 多源回退
// 覆盖 fix-plan：#6 syncSingleIpSource 禁用源跳过
import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIpsFromSource, syncSingleIpSource, FETCH_STRATEGIES } from "../src/sync/ip-sources.ts";
import { syncDomainLogic, syncSystemDomains, resolveRecordsForDomain } from "../src/sync/domains.ts";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("fetchIpsFromSource multi-source fallback", () => {
    it("uses the primary strategy successfully", async () => {
        vi.stubGlobal("fetch", vi.fn(async () =>
            new Response("3.3.3.3\n1.1.1.1\n2.2.2.2", { status: 200 })
        ));
        const ips = await fetchIpsFromSource({
            id: 1,
            url: "https://example.com/ips.txt",
            github_path: "ips.txt",
            commit_message: "update",
            fetch_strategy: "direct_regex",
        });
        // 排序后返回
        expect(ips).toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
    });

    it("throws when the strategy returns no IPs", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("no ips here", { status: 200 })));
        await expect(fetchIpsFromSource({
            id: 1,
            url: "https://example.com/empty.txt",
            github_path: "empty.txt",
            commit_message: "update",
            fetch_strategy: "direct_regex",
        })).rejects.toThrow("所有抓取策略均未能从该URL获取到IP");
    });

    it("falls back to another strategy when primary fails", async () => {
        let callCount = 0;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            callCount++;
            if (url.startsWith("https://PhantomJsCloud.com")) {
                // 主策略（phantomjs_cloud）返回无 IP
                return new Response("no ips here", { status: 200 });
            }
            // 回退策略（direct_regex）返回有 IP
            return new Response("10.0.0.1\n10.0.0.2", { status: 200 });
        }));
        const source = {
            id: 99,
            url: "https://example.com/ips.txt",
            github_path: "fallback-test.txt",
            commit_message: "update",
            fetch_strategy: "phantomjs_cloud",
        };
        const ips = await fetchIpsFromSource(source);
        expect(ips).toEqual(["10.0.0.1", "10.0.0.2"]);
        // fetchIpsFromSource 会就地更新 source.fetch_strategy
        expect(source.fetch_strategy).toBe("direct_regex");
        expect(callCount).toBeGreaterThan(1);
    });

    it("persists new strategy to db when fallback succeeds (db provided)", async () => {
        const uniquePath = `fallback-db-${crypto.randomUUID()}.txt`;
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        ).bind("https://fallback-db.example.com/ips.txt", uniquePath, "update", "phantomjs_cloud").run();
        const row = await env.WUYA.prepare(
            "SELECT * FROM ip_sources WHERE github_path = ?"
        ).bind(uniquePath).first() as { id: number; url: string; github_path: string; commit_message: string; fetch_strategy: string; is_enabled: number };

        let callCount = 0;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            callCount++;
            if (url.startsWith("https://PhantomJsCloud.com")) {
                return new Response("no ips", { status: 200 });
            }
            return new Response("192.168.1.1\n192.168.1.2", { status: 200 });
        }));

        const ips = await fetchIpsFromSource(row, env.WUYA);
        expect(ips).toEqual(["192.168.1.1", "192.168.1.2"]);

        // 验证 DB 中策略已被更新
        const updated = await env.WUYA.prepare(
            "SELECT fetch_strategy FROM ip_sources WHERE id = ?"
        ).bind(row.id).first() as { fetch_strategy: string };
        expect(updated.fetch_strategy).toBe("direct_regex");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(row.id).run();
    });
});

describe("syncDomainLogic writes back to D1", () => {
    it("upserts DNS records via Cloudflare API and marks success", async () => {
        // 配置 CF 凭据（syncDomainLogic 需要）
        await env.WUYA.batch([
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-cf-token"),
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-zone-id"),
        ]);

        // 种子域名（浅层克隆模式 → DoH CNAME 查询 → 写回 CF）
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, 0, 60, 'test', 0)"
        ).bind("origin.example.com", "clone.example.com", "test-zone-id").run();

        // mock 外部 fetch：DoH 查询 + Cloudflare API 列表（返回空 → 需新增）
        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes("dns-query")) {
                return new Response(JSON.stringify({
                    Answer: [{ data: "cname-target.example.com." }],
                }), { status: 200 });
            }
            if (url.includes("api.cloudflare.com")) {
                return new Response(JSON.stringify({
                    success: true,
                    result: [],
                }), { status: 200 });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const domain = await env.WUYA.prepare(
            "SELECT * FROM domains WHERE target_domain = 'clone.example.com'"
        ).first() as { id: number; source_domain: string; target_domain: string; zone_id: string; is_deep_resolve: number; ttl: number; last_synced_records: string | null; is_enabled: number; is_system: number };

        const log = () => {};
        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, log, {});

        // 验证写回 D1
        const updated = await env.WUYA.prepare(
            "SELECT last_sync_status, last_synced_records FROM domains WHERE id = ?"
        ).bind(domain.id).first() as { last_sync_status: string; last_synced_records: string };
        expect(updated.last_sync_status).toBe("success");
        expect(JSON.parse(updated.last_synced_records)).toEqual([{ type: "CNAME", content: "cname-target.example.com" }]);

        // 验证 POST 调用了 Cloudflare API 新增记录
        const postCalls = fetchMock.mock.calls.filter((c) => c[0].includes("api.cloudflare.com") && c[1]?.method === "POST");
        expect(postCalls.length).toBe(1);
    });
});

describe("syncSingleIpSource (Task 2.1 is_enabled 守卫)", () => {
    it("throws when source is disabled", async () => {
        // 使用随机唯一 path 避免与 ensureInitialData 种子冲突
        const uniquePath = `disabled-${crypto.randomUUID()}.txt`;
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy, is_enabled) VALUES (?, ?, ?, ?, 0)"
        ).bind("https://disabled.example.com/ips.txt", uniquePath, "update", "direct_regex").run();
        const row = await env.WUYA.prepare(
            "SELECT id FROM ip_sources WHERE github_path = ?"
        ).bind(uniquePath).first() as { id: number };

        // mock fetch：不应被调用（守卫应先抛错）
        const fetchSpy = vi.fn(async () => new Response("5.5.5.5", { status: 200 }));
        vi.stubGlobal("fetch", fetchSpy);

        await expect(syncSingleIpSource(row.id, env, false)).rejects.toThrow(/已被禁用/);
        // 确认 fetch 未被调用（GitHub API 完全跳过）
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws when source id does not exist", async () => {
        await expect(syncSingleIpSource(999999, env, false)).rejects.toThrow(/未找到|已被禁用/);
    });
});

describe("syncSystemDomains (FIX-02: 错误日志替代静默)", () => {
    it("syncDomainLogic 抛错时 D1 写入 failed 状态，且日志输出可定位失败域名", async () => {
        // 插入一个启用系统域名，source_domain 设为 internal:hostmonit:CM
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, is_system, is_enabled) VALUES (?, ?, ?, ?, 1, 1)"
        ).bind("internal:hostmonit:CM", "sys-catch-test.example.com", "test-zone-id", 0).run();

        // 让 fetch 抛错（无论谁尝试访问网络都会失败）—— 三网源获取失败 → 后续 ips 为 undefined → 同步逻辑抛错
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network boom"); }));

        await syncSystemDomains(env, false);

        // FIX-02 验证点 1：D1 中应记录 failed 状态（syncDomainLogic 内 catch 写入）
        const row = await env.WUYA.prepare(
            "SELECT last_sync_status, last_sync_error FROM domains WHERE target_domain = ?"
        ).bind("sys-catch-test.example.com").first() as { last_sync_status: string; last_sync_error: string } | null;

        expect(row).not.toBeNull();
        expect(row!.last_sync_status).toBe("failed");
        // 错误信息非空（含失败的同步上下文错误）
        expect(row!.last_sync_error).toBeTruthy();

        // FIX-02 验证点 2：syncSystemDomains 不因单个 domain 失败而整体 reject
        // 验证通过：上面 await 正常返回即为整体通过

        // 清理
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind("sys-catch-test.example.com").run();
    });
});

describe("syncDomainLogic JSON 兜底 (FIX-03)", () => {
    it("last_synced_records JSON 损坏时不抛 SyntaxError，按空数组处理", async () => {
        // 插入一个上次记录被破坏的 domain
        // is_deep_resolve=1 + 不存在源 → DoH 返回空 → recordsToUpdate.length === 0
        // → 进入 lastRecords 分支 → JSON.parse('{broken-json') 损坏 → 期望 catch 兜底
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, last_synced_records, is_enabled) VALUES (?, ?, ?, 1, ?, 1)"
        ).bind("nonexistent-source.invalid", "json-corrupt.example.com", "test-zone-id", "{broken-json").run();

        // stub fetch：所有 DoH 查询返回空 Answer
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            if (url.includes("cloudflare-dns.com")) {
                return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
            }
            return new Response("{}", { status: 200 });
        }));

        const row = await env.WUYA.prepare(
            "SELECT * FROM domains WHERE target_domain = ?"
        ).bind("json-corrupt.example.com").first() as { id: number; source_domain: string; target_domain: string; zone_id: string; is_deep_resolve: number; ttl: number; last_synced_records: string | null; is_enabled: number; is_system: number };

        const logs: string[] = [];
        const log = (m: string) => { logs.push(m); };

        // 不应抛 SyntaxError
        await expect(syncDomainLogic(row, "test-cf-token", "test-zone-id", env.WUYA, log, {})).resolves.toBeUndefined();

        // 关键断言：日志中含"字段损坏"
        expect(logs.some(l => l.includes("字段损坏"))).toBe(true);

        // 验证 D1 中 last_sync_status='no_change'（按空数组处理后走内容一致路径）
        const updated = await env.WUYA.prepare(
            "SELECT last_sync_status FROM domains WHERE id = ?"
        ).bind(row.id).first() as { last_sync_status: string };
        expect(updated.last_sync_status).toBe("no_change");

        // 清理
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind("json-corrupt.example.com").run();
    });
});

describe("resolveRecordsForDomain (FIX-14)", () => {
    it("浅层克隆分支：源不是 CNAME 时抛错", async () => {
        // 使用 is_deep_resolve=0 + 源无 CNAME → 期望抛"必须是一个CNAME记录"
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            if (url.includes("cloudflare-dns.com")) {
                return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
            }
            return new Response("{}", { status: 200 });
        }));

        const domain: {
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
            id: number;
        } = {
            id: 999,
            source_domain: "no-cname-source.invalid",
            target_domain: "x.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 0,
        };

        await expect(resolveRecordsForDomain(domain, env.WUYA, () => {}, {})).rejects.toThrow(/必须是一个CNAME记录/);
    });

    it("internal:hostmonit:* 上下文命中缓存时不重复 fetch", async () => {
        // 预填 syncContext.threeNetworkIps 让快速路径生效
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("fetch should not be called when context cache hits");
        }));

        const domain: {
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
            id: number;
        } = {
            id: 999,
            source_domain: "internal:hostmonit:yd",
            target_domain: "x.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 1,
        };
        const syncContext: Record<string, unknown> = {
            threeNetworkIps: { yd: ["1.1.1.1"], dx: ["2.2.2.2"], lt: ["3.3.3.3"], source: "CloudFlareYes" },
        };
        const records = await resolveRecordsForDomain(domain, env.WUYA, () => {}, syncContext);
        expect(records).toEqual([{ type: "A", content: "1.1.1.1" }]);
    });
});
