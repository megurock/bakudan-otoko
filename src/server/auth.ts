export interface AuthEnv {
  BASIC_USER?: string;
  BASIC_PASS?: string;
}

const REALM = 'Basic realm="bomberman", charset="UTF-8"';

function unauthorized(withChallenge: boolean): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: withChallenge ? { "WWW-Authenticate": REALM } : {},
  });
}

// timingSafeEqual はバイト長が異なると例外を投げるため、
// 両値を SHA-256 ダイジェスト（常に32バイト）に揃えてから比較する
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const da = await crypto.subtle.digest("SHA-256", enc.encode(a));
  const db = await crypto.subtle.digest("SHA-256", enc.encode(b));
  return crypto.subtle.timingSafeEqual(da, db);
}

function decodeBase64Utf8(encoded: string): string | null {
  try {
    const bin = atob(encoded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Basic 認証チェック。認証済みなら null、未認証なら 401 Response を返す。
 */
export async function requireBasicAuth(
  request: Request,
  env: AuthEnv,
): Promise<Response | null> {
  // secrets 未設定時は全拒否（500 ではなく 401）
  if (!env.BASIC_USER || !env.BASIC_PASS) return unauthorized(true);

  const header = request.headers.get("Authorization");
  if (!header) return unauthorized(true);

  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return unauthorized(true);

  const decoded = decodeBase64Utf8(encoded);
  if (decoded === null) return unauthorized(true);

  const colon = decoded.indexOf(":");
  if (colon < 0) return unauthorized(true);
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  const userOk = await safeEqual(user, env.BASIC_USER);
  const passOk = await safeEqual(pass, env.BASIC_PASS);
  if (!(userOk && passOk)) return unauthorized(true);

  return null;
}

/** /logout 用: WWW-Authenticate なしの 401 で資格情報の再プロンプトを回避 */
export function logoutResponse(): Response {
  return unauthorized(false);
}
