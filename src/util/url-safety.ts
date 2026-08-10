// url-safety.ts — URL 安全校验：仅允许 http/https 协议且非内网/元数据地址
// 用于防范 SSRF：阻止 Worker 向 169.254.169.254、10.0.0.0/8、CodeTabs/PhantomJS 代理访问内网等场景

/**
 * 校验 URL 仅允许 http/https 协议且非内网地址
 * @throws Error 当协议非 http/https 或主机为内网/回环/链路本地/云元数据时
 */
export function assertSafeHttpUrl(raw: string): URL {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error("URL 格式无效。");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("仅允许 http/https 协议。");
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    // 回环 / 私有 / 链路本地 / CGNAT / 云元数据
    const privatePatterns = [
        /^127\./,
        /^10\./,
        /^192\.168\./,
        /^169\.254\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^0\./,
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
        /^::1$/,
        /^fe80:/i,
        /^fc00:/i,
        /^fd/i,
        /^metadata\.google\.internal$/i,
    ];
    if (privatePatterns.some(re => re.test(host))) {
        throw new Error("不允许访问内网或元数据地址。");
    }
    return u;
}
