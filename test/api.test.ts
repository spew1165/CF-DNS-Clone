// api.test.ts — API 路由分发 + 登录 + 域名 CRUD + 设置白名单 + 权限守卫 + 敏感字段过滤
// 覆盖 plan v2 用例表 + fix-plan 14 项 findings 回归
import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// 种子密码（见 apply-migrations.ts）
const PASSWORD = "test-password-123";

async function loginAndGetCookie(): Promise<string> {
    const res = await SELF.fetch("https://example.com/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") as string;
    return setCookie.split(";")[0];
}

/** 注入 CF 凭据，确保 handleDomainMutation 服务端拼装 target_domain 流程可走通 */
async function seedCfSettings(): Promise<void> {
    await env.WUYA.batch([
        env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-token"),
        env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-zone-id"),
    ]);
}

describe("/api/login", () => {
    it("rejects wrong password with 401", async () => {
        const res = await SELF.fetch("https://example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "wrong-password" }),
        });
        expect(res.status).toBe(401);
    });

    it("returns 200 with Set-Cookie for correct password", async () => {
        const res = await SELF.fetch("https://example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: PASSWORD }),
        });
        expect(res.status).toBe(200);
        const setCookie = res.headers.get("Set-Cookie");
        expect(setCookie).toContain("session=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("Max-Age=86400");
    });
});

describe("/api/domains routing", () => {
    it("returns 401 unauthenticated", async () => {
        const res = await SELF.fetch("https://example.com/api/domains");
        expect(res.status).toBe(401);
    });

    it("returns 200 with empty list after login", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/domains", {
            headers: { Cookie: cookie },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as unknown[];
        expect(Array.isArray(body)).toBe(true);
    });

    it("returns 404 for unknown API endpoint", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/nonexistent", {
            headers: { Cookie: cookie },
        });
        expect(res.status).toBe(404);
    });
});

describe("POST /api/domains (Task 1.1 API/UI 契约对齐)", () => {
    it("accepts target_domain_prefix and assembles target_domain server-side", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        // mock zone name lookup
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            if (url.includes("api.cloudflare.com")) {
                return new Response(JSON.stringify({ success: true, result: { name: "example.com" } }), { status: 200 });
            }
            return origFetch(url);
        }) as typeof fetch;
        try {
            const res = await SELF.fetch("https://example.com/api/domains", {
                method: "POST",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_domain: "origin.example.com",
                    target_domain_prefix: "clone",
                    is_deep_resolve: 1,
                    ttl: 60,
                    notes: "test domain",
                }),
            });
            expect(res.status).toBe(200);
            // 验证 target_domain 服务端拼装为 "clone.example.com"
            const row = await env.WUYA.prepare("SELECT target_domain, source_domain FROM domains WHERE target_domain = ?").bind("clone.example.com").first() as { target_domain: string; source_domain: string };
            expect(row).not.toBeNull();
            expect(row.source_domain).toBe("origin.example.com");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("returns 400 when target_domain_prefix is missing", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await SELF.fetch("https://example.com/api/domains", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ source_domain: "origin.example.com" }),
        });
        expect(res.status).toBe(400);
    });
});

describe("PUT /api/domains/:id (Task 1.3 系统域名守卫)", () => {
    it("rejects modifying source_domain of system domain with 403", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        // 种子系统域名
        await env.WUYA.prepare("INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, 1, 60, '系统', 1)")
            .bind("internal:hostmonit:yd", "yd.example.com", "test-zone-id").run();
        const sysRow = await env.WUYA.prepare("SELECT id FROM domains WHERE is_system = 1").first() as { id: number };

        // mock zone name
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            if (url.includes("api.cloudflare.com")) {
                return new Response(JSON.stringify({ success: true, result: { name: "example.com" } }), { status: 200 });
            }
            return origFetch(url);
        }) as typeof fetch;
        try {
            const res = await SELF.fetch(`https://example.com/api/domains/${sysRow.id}`, {
                method: "PUT",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_domain: "evil.example.com", // 试图篡改
                    target_domain_prefix: "yd",
                    ttl: 60,
                }),
            });
            expect(res.status).toBe(403);
            // 确认 source_domain 未被修改
            const after = await env.WUYA.prepare("SELECT source_domain FROM domains WHERE id = ?").bind(sysRow.id).first() as { source_domain: string };
            expect(after.source_domain).toBe("internal:hostmonit:yd");
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

describe("POST /api/settings (Task 2.6 白名单 + 配对验证)", () => {
    it("rejects when only CF_API_TOKEN provided (missing CF_ZONE_ID)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ CF_API_TOKEN: "abc" }),
        });
        expect(res.status).toBe(400);
    });

    it("rejects when only CF_ZONE_ID provided (missing CF_API_TOKEN)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ CF_ZONE_ID: "xyz" }),
        });
        expect(res.status).toBe(400);
    });

    it("rejects partial GitHub settings (only GITHUB_TOKEN)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ GITHUB_TOKEN: "ghp_xxx" }),
        });
        expect(res.status).toBe(400);
    });

    it("drops unknown keys (whitelist enforcement)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                THREE_NETWORK_SOURCE: "wetest.vip", // 合法 key
                SECRET_INJECTION: "should-not-persist", // 非法 key
            }),
        });
        expect(res.status).toBe(200);
        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'SECRET_INJECTION'").first();
        expect(row).toBeNull();
        const legit = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'THREE_NETWORK_SOURCE'").first() as { value: string };
        expect(legit.value).toBe("wetest.vip");
    });
});

describe("GET /api/settings (Task 2.5 敏感字段过滤)", () => {
    it("does not leak ADMIN_PASSWORD_HASH or tokens to client", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            headers: { Cookie: cookie },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, string>;
        expect(body.ADMIN_PASSWORD_HASH).toBeUndefined();
        expect(body.PASSWORD_SALT).toBeUndefined();
        expect(body.CF_API_TOKEN).toBeUndefined();
        expect(body.GITHUB_TOKEN).toBeUndefined();
    });
});