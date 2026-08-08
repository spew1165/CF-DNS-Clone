// sync.test.ts — 用例 3/4：域名同步写回 D1 + IP 源多源回退
// 覆盖 plan v2 用例表：#3 syncDomainRecord 写回 D1、#4 fetchIpSource 多源回退
import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIpsFromSource, FETCH_STRATEGIES } from "../src/sync/ip-sources.ts";
import { syncDomainLogic } from "../src/sync/domains.ts";

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
        })).rejects.toThrow("No IPs found");
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
