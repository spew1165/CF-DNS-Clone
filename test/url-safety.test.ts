// url-safety.test.ts — FIX-04：assertSafeHttpUrl 覆盖各协议/内网/边界
import { describe, it, expect } from "vitest";
import { assertSafeHttpUrl } from "../src/util/url-safety.ts";

describe("assertSafeHttpUrl (FIX-04)", () => {
    it("接受公网 https URL", () => {
        const u = assertSafeHttpUrl("https://example.com/foo/bar");
        expect(u.protocol).toBe("https:");
        expect(u.hostname).toBe("example.com");
    });

    it("接受公网 http URL", () => {
        const u = assertSafeHttpUrl("http://example.org:8080/path");
        expect(u.protocol).toBe("http:");
    });

    it("拒绝 169.254.169.254 云元数据", () => {
        expect(() => assertSafeHttpUrl("http://169.254.169.254/latest/meta-data/")).toThrow(/内网|元数据/);
    });

    it("拒绝 10.0.0.0/8 私有网段", () => {
        expect(() => assertSafeHttpUrl("http://10.0.0.1/admin")).toThrow(/内网|元数据/);
    });

    it("拒绝 192.168.0.0/16 私有网段", () => {
        expect(() => assertSafeHttpUrl("http://192.168.1.1/")).toThrow(/内网|元数据/);
    });

    it("拒绝 172.16-31.x.x 私有网段", () => {
        expect(() => assertSafeHttpUrl("http://172.16.0.1/")).toThrow(/内网|元数据/);
        expect(() => assertSafeHttpUrl("http://172.20.0.1/")).toThrow(/内网|元数据/);
        expect(() => assertSafeHttpUrl("http://172.31.255.255/")).toThrow(/内网|元数据/);
    });

    it("拒绝 127.0.0.0/8 回环", () => {
        expect(() => assertSafeHttpUrl("http://127.0.0.1/")).toThrow(/内网|元数据/);
    });

    it("拒绝 0.0.0.0/8", () => {
        expect(() => assertSafeHttpUrl("http://0.0.0.0/")).toThrow(/内网|元数据/);
    });

    it("拒绝 100.64-127 CGNAT 段", () => {
        expect(() => assertSafeHttpUrl("http://100.64.0.1/")).toThrow(/内网|元数据/);
        expect(() => assertSafeHttpUrl("http://100.127.255.255/")).toThrow(/内网|元数据/);
    });

    it("拒绝 IPv6 回环 ::1", () => {
        expect(() => assertSafeHttpUrl("http://[::1]/")).toThrow(/内网|元数据/);
    });

    it("拒绝 link-local fe80::", () => {
        expect(() => assertSafeHttpUrl("http://[fe80::1]/")).toThrow(/内网|元数据/);
    });

    it("拒绝 metadata.google.internal", () => {
        expect(() => assertSafeHttpUrl("http://metadata.google.internal/")).toThrow(/内网|元数据/);
    });

    it("拒绝 file:// 协议", () => {
        expect(() => assertSafeHttpUrl("file:///etc/passwd")).toThrow(/协议/);
    });

    it("拒绝 javascript: 协议", () => {
        expect(() => assertSafeHttpUrl("javascript:alert(1)")).toThrow(/协议/);
    });

    it("拒绝 data: 协议", () => {
        expect(() => assertSafeHttpUrl("data:text/plain,hello")).toThrow(/协议/);
    });

    it("拒绝无效 URL", () => {
        expect(() => assertSafeHttpUrl("not-a-url")).toThrow(/格式无效/);
    });

    it("拒绝空字符串", () => {
        expect(() => assertSafeHttpUrl("")).toThrow(/格式无效/);
    });

    it("172.15.x.x 不在黑名单边界外（应通过）", () => {
        expect(() => assertSafeHttpUrl("http://172.15.0.1/")).not.toThrow();
    });

    it("172.32.x.x 不在黑名单边界外（应通过）", () => {
        expect(() => assertSafeHttpUrl("http://172.32.0.1/")).not.toThrow();
    });

    it("公网域名混合大小写通过", () => {
        expect(() => assertSafeHttpUrl("HTTPS://Example.COM/abc")).not.toThrow();
    });
});
