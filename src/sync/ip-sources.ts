// ip-sources.ts — IP 源抓取与同步逻辑
// 从 index.legacy.js 提取（原 1158-1236、1598-1673 行）

// 注意：dummy_strategy_4~30 为原文件既有代码（疑似测试残留），按"不删预存代码"原则原样保留

interface IpSourceRow {
    id: number;
    url: string;
    github_path: string;
    commit_message: string;
    fetch_strategy: string;
}

type StrategyFn = (url: string) => Promise<string[]>;

/** 抓取策略表 */
export const FETCH_STRATEGIES: Record<string, StrategyFn> = {
    direct_regex: async (url) => {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const text = await res.text();
        const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
        return [...new Set(ips)];
    },
    phantomjs_cloud: async (url) => {
        const res = await fetch('https://PhantomJsCloud.com/api/browser/v2/a-demo-key-with-low-quota-per-ip-address/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, renderType: 'html' })
        });
        if (!res.ok) throw new Error(`PhantomJsCloud API error ${res.status}`);
        const text = await res.text();
        const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
        return [...new Set(ips)];
    },
    proxy_codetabs: async (url) => {
        const proxyUrl = 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url);
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error(`CodeTabs Proxy error ${res.status}`);
        const text = await res.text();
        const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
        return [...new Set(ips)];
    },
};
for (let i = 4; i <= 30; i++) {
    FETCH_STRATEGIES[`dummy_strategy_${i}`] = async (url) => {
        if (url.includes("special-case")) {
            return ["1.2.3." + i];
        }
        throw new Error("Dummy strategy failed");
    };
}

/** 按策略抓取 IP（带排序） */
export async function fetchIpsFromSource(source: IpSourceRow): Promise<string[]> {
    const strategyFn = FETCH_STRATEGIES[source.fetch_strategy];
    if (!strategyFn) {
        throw new Error(`Unknown fetch strategy: ${source.fetch_strategy}`);
    }
    const ips = await strategyFn(source.url);
    if (!ips || ips.length === 0) {
        throw new Error('No IPs found using the cached strategy.');
    }
    const sortIps = (a: string, b: string) => {
        const aParts = a.split('.').map(Number);
        const bParts = b.split('.').map(Number);
        for (let i = 0; i < 4; i++) {
            if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
        }
        return 0;
    };
    return ips.sort(sortIps);
}

/** 三大运营商 IP 抓取（hostmonit HTML 表格解析） */
export async function fetchThreeNetworkIps(source: string, log: (msg: string) => void): Promise<{ yd: string[]; dx: string[]; lt: string[] }> {
    log(`正在从源 [${source}] 获取IP...`);

    async function parseHtmlTableWithOperator(htmlContent: string) {
        const ips: { yd: Set<string>; dx: Set<string>; lt: Set<string> } = { yd: new Set(), dx: new Set(), lt: new Set() };
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

        let rowMatch;
        while ((rowMatch = rowRegex.exec(htmlContent)) !== null) {
            const cells = Array.from(rowMatch[1].matchAll(cellRegex), m => m[1].replace(/<[^>]+>/g, '').trim());
            if (cells.length >= 2) {
                const lineCell = cells.find(c => c.includes('电信') || c.includes('联通') || c.includes('移动'));
                const ipCell = cells.find(c => ipRegex.test(c));

                if (lineCell && ipCell) {
                    const ip = ipCell.match(ipRegex)?.[0] as string;
                    if (lineCell.includes('移动')) ips.yd.add(ip);
                    else if (lineCell.includes('电信')) ips.dx.add(ip);
                    else if (lineCell.includes('联通')) ips.lt.add(ip);
                }
            }
        }

        const allIpsArray = [...ips.yd, ...ips.dx, ...ips.lt];
        if (allIpsArray.length > 0) {
            const allIps = new Set(allIpsArray);
            if (ips.yd.size === 0) ips.yd = allIps;
            if (ips.dx.size === 0) ips.dx = allIps;
            if (ips.lt.size === 0) ips.lt = allIps;
        }

        return { yd: Array.from(ips.yd), dx: Array.from(ips.dx), lt: Array.from(ips.lt) };
    }

    try {
        let url: string;
        let usePhantom = false;
        switch (source) {
            case 'api.uouin.com':
                url = 'https://api.uouin.com/cloudflare.html';
                break;
            case 'wetest.vip':
                url = 'https://www.wetest.vip/page/cloudflare/address_v4.html';
                break;
            case 'CloudFlareYes':
            default:
                url = 'https://stock.hostmonit.com/CloudFlareYes';
                usePhantom = true;
                break;
        }

        const res = usePhantom
            ? await fetch('https://PhantomJsCloud.com/api/browser/v2/a-demo-key-with-low-quota-per-ip-address/', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url, renderType: 'html' })
              })
            : await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);

        const htmlContent = await res.text();
        const result = await parseHtmlTableWithOperator(htmlContent);
        log(`从 [${source}] 获取到 ${result.yd.length + result.dx.length + result.lt.length} 个IP。`);
        return result;
    } catch (e) {
        log(`从源 [${source}] 获取IP失败: ${e instanceof Error ? e.message : String(e)}`);
        return { yd: [], dx: [], lt: [] };
    }
}
