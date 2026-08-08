// auth.test.ts — 用例 7/8：hashPassword + isAuthenticated
// 中文注释；断言文案用英文（文案三档规则）
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { hashPassword, isAuthenticated } from "../src/util/auth.ts";

describe("hashPassword", () => {
    it("returns a hex string of 64 chars", async () => {
        const hash = await hashPassword("test-password-123", "test-salt");
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different hashes for different salts", async () => {
        const h1 = await hashPassword("same-password", "salt-1");
        const h2 = await hashPassword("same-password", "salt-2");
        expect(h1).not.toBe(h2);
    });

    it("fails to match a tampered hash", async () => {
        const hash = await hashPassword("test-password-123", "test-salt");
        const tampered = hash.slice(0, -2) + (hash.endsWith("00") ? "ff" : "00");
        expect(tampered).not.toBe(hash);
    });
});

describe("isAuthenticated", () => {
    it("returns true for a valid session cookie", async () => {
        const token = crypto.randomUUID();
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await env.WUYA.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expires).run();
        const request = new Request("https://example.com/admin", {
            headers: { Cookie: `session=${token}` },
        });
        expect(await isAuthenticated(request, env.WUYA)).toBe(true);
    });

    it("returns false for an expired session cookie", async () => {
        const token = crypto.randomUUID();
        const expires = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await env.WUYA.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expires).run();
        const request = new Request("https://example.com/admin", {
            headers: { Cookie: `session=${token}` },
        });
        expect(await isAuthenticated(request, env.WUYA)).toBe(false);
    });

    it("returns false without a cookie", async () => {
        const request = new Request("https://example.com/admin");
        expect(await isAuthenticated(request, env.WUYA)).toBe(false);
    });
});
