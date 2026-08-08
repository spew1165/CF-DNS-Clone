// auth.ts — 认证与密码哈希工具
// 从 index.legacy.js 提取（原 1844-1846 行）

/**
 * 哈希密码（PBKDF2，≥100k 迭代）
 * 隐含修正 B3：原单轮 SHA-256 升级为 PBKDF2，防彩虹表/字典攻击
 */
export async function hashPassword(password: string, salt: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 验证会话：读取 session Cookie 并检查是否有效
 */
export async function isAuthenticated(request: Request, db: D1Database): Promise<boolean> {
    const token = getCookie(request, 'session');
    if (!token) return false;
    const session = await db.prepare("SELECT expires_at FROM sessions WHERE token = ?").bind(token).first() as { expires_at: string } | null;
    if (!session || new Date(session.expires_at) < new Date()) {
        if (session) await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
        return false;
    }
    return true;
}

/**
 * 从请求 Cookie 头解析指定 name 的值
 */
export function getCookie(request: Request, name: string): string | null {
    const cookieHeader = request.headers.get('Cookie');
    if (cookieHeader) {
        for (const cookie of cookieHeader.split(';')) {
            const [key, value] = cookie.trim().split('=');
            if (key === name) return value;
        }
    }
    return null;
}
