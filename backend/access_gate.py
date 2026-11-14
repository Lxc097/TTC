"""队友测试入口：一个共享口令，把「只有本机能开」变成「知道口令的人都能开」。

为什么需要它
------------
要让队友测这套东西，只有两种做法：

    A. 把 API key 发给他们，各自在本机跑
       —— 密钥失控：key 进了别人的 .env、聊天记录、截图，赛后还得全部轮换。

    B. 只开一台机器持有 key，队友拿一个链接进来
       —— key 不出那台机器，但链接会被转发，而这里没有账号体系。

B 是对的方向，缺的只是一道门。这道门**不做身份、不做权限**，只回答一个问题：
「拿到这个链接的人，是不是我们组的。」

所以它是「共享口令 + 签名 cookie」，不是账号体系，也不该被当成账号体系用：
凡是拿到口令的人，在企业端就是 HR 视角。真要分人，得上真正的账号/邀请码系统。

设计约束
--------
1. **默认关闭**：``TTC_ACCESS_CODE`` 为空时本模块完全不介入。
   本机开发、单测、CI 的行为一个字节都不变。
2. **纯 ASGI**：FastAPI 的 ``@app.middleware("http")`` 看不到 WebSocket，
   而面试主链路（``/ws/room/{code}``）就是 WS，漏掉等于没设防。
3. **换口令即吊销**：cookie 的签名是用口令本身派生的，改 ``.env`` 重启后
   所有已发出的 cookie 立刻失效 —— 不需要额外的密钥管理。
4. **不挡健康检查和签证书**：``/healthz`` 和 ``/.well-known/`` 必须放行，
   否则 nginx/监控/ACME 都会被门挡在外面。
5. **不挡 CORS 预检**：OPTIONS 直接放行，否则浏览器连登录页都发不出去。

已知边界（很重要）
------------------
``recruitment_api.demo_enabled()`` 原来用「客户端 IP 是 loopback」来判断
「这是本机演示」。这个判断**一旦套上任何反向代理就是假的**：nginx、
cloudflared、frp 都是从 127.0.0.1 连过来的，远端用户同样「看起来是本机」。

所以本模块给 ``demo_enabled()`` 提供了第二个、也是唯一诚实的判据：
「口令验证通过」。只要门是开着的，就说明进来的人是我们让进来的。
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import time
from http.cookies import SimpleCookie

COOKIE_NAME = "ttc_access"
LOGIN_PATH = "/__access"
_VERSION = "v1"

# 这些路径永远放行：探活、证书签发、CORS 预检。
_ALWAYS_OPEN = ("/healthz", "/favicon.ico")


def _sign(code: str, issued: int) -> str:
    """用口令本身当 HMAC 密钥 —— 不引入第二个需要保管的秘密。"""
    msg = f"{_VERSION}.{issued}".encode("utf-8")
    return hmac.new(code.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:32]


def make_token(code: str, issued: int | None = None) -> str:
    """生成一个 cookie 值。同一秒内重复生成结果相同（幂等，方便测试）。"""
    issued = int(time.time()) if issued is None else int(issued)
    return f"{_VERSION}.{issued}.{_sign(code, issued)}"


def token_ok(token: str, code: str, days: int = 0) -> bool:
    """校验 cookie。``days <= 0`` 表示不看时间，只认签名。"""
    if not token or not code:
        return False
    try:
        version, issued, sig = token.split(".", 2)
        issued_at = int(issued)
    except (AttributeError, ValueError):
        return False
    if version != _VERSION:
        return False
    if not hmac.compare_digest(sig, _sign(code, issued_at)):
        return False
    if days > 0 and time.time() - issued_at > days * 86400:
        return False
    return True


def _cookie_value(headers) -> str:
    for key, value in headers or ():
        if key.lower() == b"cookie":
            jar = SimpleCookie()
            try:
                jar.load(value.decode("latin-1"))
            except Exception:                      # 畸形 cookie 不致命，当作没登录
                return ""
            morsel = jar.get(COOKIE_NAME)
            return morsel.value if morsel else ""
    return ""


def verified_scope(scope: dict, code: str, days: int = 0) -> bool:
    """ASGI scope 版本：HTTP 和 WebSocket 都能用。"""
    if not code:
        return True                            # 没开门 = 谁都能进（本机默认）
    return token_ok(_cookie_value(scope.get("headers")), code, days)


def verified_request(request, code: str, days: int = 0) -> bool:
    """FastAPI ``Request`` 版本，供 ``demo_enabled()`` 这类同步判断使用。"""
    if not code:
        return False                           # 这里语义相反：没设口令 = 没有凭据可依
    return token_ok(request.cookies.get(COOKIE_NAME, ""), code, days)


def _is_https(scope: dict) -> bool:
    if scope.get("scheme") == "https":
        return True
    for key, value in scope.get("headers") or ():
        if key.lower() == b"x-forwarded-proto":
            return value.decode("latin-1").split(",")[0].strip() == "https"
    return False


def _safe_next(raw: str) -> str:
    """只接受站内的绝对路径，挡掉 ``//evil.com`` 和完整 URL 形式的跳转。"""
    if not raw or not raw.startswith("/") or raw.startswith("//"):
        return "/"
    if "\\" in raw or "\r" in raw or "\n" in raw:
        return "/"
    return raw


def _gate_page(next_path: str, error: str = "") -> bytes:
    message = (
        f'<p class="err" role="alert">{html.escape(error)}</p>' if error else ""
    )
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TTC · 输入测试口令</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;
         background:#0e1116; color:#e8edf4; }}
  main {{ width:min(380px,88vw); }}
  h1 {{ font-size:19px; font-weight:600; margin:0 0 6px; }}
  p.hint {{ margin:0 0 22px; color:#93a1b3; font-size:13px; }}
  p.err {{ margin:0 0 14px; padding:9px 12px; border-radius:8px;
           background:#3a1d22; color:#ffb4bd; font-size:13px; }}
  input,button {{ width:100%; box-sizing:border-box; border-radius:9px;
                  padding:11px 13px; font:inherit; }}
  input {{ border:1px solid #2b3440; background:#161b23; color:inherit; }}
  input:focus {{ outline:2px solid #3b82f6; outline-offset:1px; border-color:transparent; }}
  button {{ margin-top:12px; border:0; background:#3b82f6; color:#fff;
            font-weight:600; cursor:pointer; }}
  button:hover {{ background:#2f6fe0; }}
</style></head>
<body><main>
  <h1>TTC 测试通道</h1>
  <p class="hint">这是内部测试环境，需要口令才能进入。</p>
  {message}
  <form method="post" action="{LOGIN_PATH}">
    <input type="hidden" name="next" value="{html.escape(next_path)}">
    <input name="code" type="password" placeholder="测试口令" autocomplete="current-password"
           autofocus required>
    <button type="submit">进入</button>
  </form>
</main></body></html>""".encode("utf-8")


class AccessGate:
    """放在最外层的 ASGI 中间件。用法：``app.add_middleware(AccessGate, code=...)``。"""

    def __init__(self, app, code: str, days: int = 14):
        self.app = app
        self.code = code or ""
        self.days = days

    async def __call__(self, scope, receive, send):
        if not self.code or scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        path = scope.get("path", "/")
        if scope["type"] == "http" and path == LOGIN_PATH:
            return await self._login(scope, receive, send)
        if path in _ALWAYS_OPEN or path.startswith("/.well-known/"):
            return await self.app(scope, receive, send)
        if scope["type"] == "http" and scope.get("method", "").upper() == "OPTIONS":
            return await self.app(scope, receive, send)
        if verified_scope(scope, self.code, self.days):
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            # 握手前关闭：浏览器侧看到的是 403，不会进入连接成功状态。
            return await send({"type": "websocket.close", "code": 4401})
        return await self._deny(scope, send)

    # ---------------------------------------------------------------- 内部
    async def _body(self, receive) -> bytes:
        chunks: list[bytes] = []
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                break
        return b"".join(chunks)

    async def _login(self, scope, receive, send) -> None:
        from urllib.parse import parse_qs

        if scope.get("method", "").upper() != "POST":
            await self._deny(scope, send, next_path="/")
            return

        raw = await self._body(receive)
        form = parse_qs(raw.decode("utf-8", "replace"))
        entered = (form.get("code") or [""])[0].strip()
        next_path = _safe_next((form.get("next") or ["/"])[0])

        if not hmac.compare_digest(entered, self.code):
            await self._deny(scope, send, next_path=next_path, error="口令不对，再试一次。")
            return

        max_age = self.days * 86400 if self.days > 0 else 31536000
        cookie = f"{COOKIE_NAME}={make_token(self.code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"
        if _is_https(scope):
            cookie += "; Secure"
        await send({
            "type": "http.response.start",
            "status": 303,
            "headers": [
                (b"location", next_path.encode("latin-1", "replace")),
                (b"set-cookie", cookie.encode("latin-1")),
                (b"cache-control", b"no-store"),
                (b"content-length", b"0"),
            ],
        })
        await send({"type": "http.response.body", "body": b""})

    async def _deny(self, scope, send, next_path: str = "/", error: str = "") -> None:
        path = scope.get("path", "/")
        wants_json = path.startswith("/api/") or path.startswith("/ws/") or path == LOGIN_PATH
        if wants_json:
            body = json.dumps({"detail": "需要测试口令。"}, ensure_ascii=False).encode("utf-8")
            headers = [(b"content-type", b"application/json; charset=utf-8")]
        else:
            body = _gate_page(next_path, error)
            headers = [(b"content-type", b"text/html; charset=utf-8")]
        headers += [(b"cache-control", b"no-store"), (b"content-length", str(len(body)).encode())]
        await send({"type": "http.response.start", "status": 401, "headers": headers})
        await send({"type": "http.response.body", "body": body})
