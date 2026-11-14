# FacePhys API 接入指南

> 基于本项目实际对接经验整理。所有数字都是实测值，不是文档摘抄。
> 对应代码：`qiyeduan/backend/vision_facephys.py`；自检工具：`tools/probe_facephys.py`、`tools/check_video.py`

---

## 0. 它能给你什么

一句话：**上传一段人脸视频，返回一组生理与状态指标。**

| 字段 | 含义 | 可靠性（实测） |
|---|---|---|
| `cardiac.hr` | 心率 BPM | ⭐⭐⭐ 最稳，主力指标 |
| `cardiac.sqi` | 信号质量 0~1 | ⭐⭐⭐ 必看，决定数据能不能用 |
| `cardiac.hr_list` | 逐点心率序列 | ⭐⭐ 可能为空，且有伪跳变（见 §6.3） |
| `liveness` | 活体检测 `is_live` / `score` | ⭐⭐⭐ 白送的，做「是不是本人」很好用 |
| `data.breathing_rate` | 呼吸率 | ⭐ 常常拿不到（见 §6.2） |
| `emotion` | 主导情绪 | ⚠️ **本项目刻意不用**（合规风险，见 §8） |
| `bp` / `spo2` | 血压 / 血氧 | ⭐ 置信度低，不建议做产品 |
| `indicators_status` | 各指标为什么没出来 | ⭐⭐⭐ 排错必看 |

**没有的东西**：它不是实时接口。一次调用返回**一个时间点的采样**，不是连续流。

---

## 1. 前置条件

1. 在 [facephys.com](https://www.facephys.com) 注册，控制台 → **API 密钥** → 创建
2. 拿到一对凭据：**Key ID** + **Secret**（注意：不是 `sk-` 那种单串，是成对的）
3. 新账号送 **1,000,000 Token** 额度
4. **字段集（fieldSet）**：默认 `standard`。可选 `basic` / `standard` / `advanced` / `full`
   > 在控制台按密钥配置，**不能在请求里传**。`capability` 只能填 `rppg`，不要写 `full`。

---

## 2. 鉴权：HMAC-SHA256 签名

三个头，缺一不可：

```
x-key-id    : <Key ID>
x-timestamp : <Unix 秒级时间戳字符串>
x-signature : Base64( HMAC-SHA256( secret_key, timestamp字符串 ) )
```

要点：

- 签名原文就是**时间戳字符串本身**，不是拼接串、不是 body、不是 URL
- 时间戳窗口 **±300 秒**，服务器时间不准就会 401
- 每次请求都要重新算（时间在变）

### Python

```python
import base64, hashlib, hmac, time

def auth_headers(key_id: str, secret: str) -> dict:
    ts = str(int(time.time()))
    sig = base64.b64encode(
        hmac.new(secret.encode(), ts.encode(), hashlib.sha256).digest()
    ).decode()
    return {"x-key-id": key_id, "x-timestamp": ts, "x-signature": sig}
```

### JavaScript（浏览器 / Node）

```js
async function authHeaders(keyId, secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(ts));
  return {
    "x-key-id": keyId,
    "x-timestamp": ts,
    "x-signature": btoa(String.fromCharCode(...new Uint8Array(sig))),
  };
}
```

---

## 3. 调用流程：三步

```
① POST /api/v2/video/upload/presign   → 拿到 OSS 直传地址
② PUT  <uploadUrl>  (body = 视频字节)
③ POST /api/v3/video/process          → 拿到检测结果
```

### ① 取直传地址

```http
POST https://www.facephys.com/api/v2/video/upload/presign
Content-Type: application/json
x-key-id: ...
x-timestamp: ...
x-signature: ...

{}
```

响应：

```json
{
  "uploadUrl": "https://facephys-gateway-api.oss-accelerate.aliyuncs.com/uploads/<keyid>/<uuid>.mp4?Expires=...&Signature=...",
  "objectKey": "uploads/<keyid>/<uuid>.mp4",
  "expiresAt": "2026-11-13T18:40:08+08:00"
}
```

### ② 上传视频

```http
PUT <uploadUrl>
Content-Type: video/mp4
```

- **不要再加签名头**，OSS 预签名 URL 自带授权
- 视频要求：**≥15 秒，30 秒最佳**；MP4 / MOV / AVI / WebM；分辨率 ≥640×480；正面人脸占画面 20% 以上
- **文件必须 ≥ 10240 字节**，太小会返回 `VIDEO_UPLOAD_INCOMPLETE`

### ③ 提交检测

```http
POST https://www.facephys.com/api/v3/video/process
Content-Type: application/json
x-key-id / x-timestamp / x-signature: ...

{"objectKey": "uploads/.../xxx.mp4", "capability": "rppg"}
```

响应（实测，已删去细节）：

```json
{
  "data": {
    "cardiac": {"hr": 102.06, "sqi": 0.384, "hr_list": [{"ts":15,"hr":87}, ...]},
    "liveness": {"is_live": true, "liveness_score": 0.861, "status": "ok",
                 "signals": {"blink_rate":1, "motion":1, "texture":1, "rppg_sqi":0.384}},
    "emotion": {"dominant": "Fear", "dominant_confidence": 0.2758},
    "behavior": {"emotional_masking":0.0013, "flow_state":0.2405,
                 "sleep_debt":0, "social_arousal":0.7257},
    "bp": {"sbp":114.6, "dbp":72.7, "confidence":0.1},
    "spo2": {"spo2":95, "confidence":0.771},
    "indicators_status": {"rr":{"status":"not_available","reason":"..."}, ...},
    "tokens_deducted": 146000,
    "remaining_tokens": 854000
  },
  "message": null,
  "video_duration": 28
}
```

---

## 4. 最小可跑示例（Python，无第三方依赖）

```python
import base64, hashlib, hmac, json, time, urllib.request

BASE, KEY_ID, SECRET = "https://www.facephys.com", "...", "..."
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

def auth():
    ts = str(int(time.time()))
    sig = base64.b64encode(hmac.new(SECRET.encode(), ts.encode(),
                                    hashlib.sha256).digest()).decode()
    return {"x-key-id": KEY_ID, "x-timestamp": ts, "x-signature": sig,
            "User-Agent": UA}          # ← UA 不能省，见 §6.1

def call(method, url, body=None, ctype="application/json", signed=True):
    h = {"User-Agent": UA}
    if signed:
        h.update(auth())
    if body is not None:
        h["Content-Type"] = ctype
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

def process(video_bytes: bytes):
    pre = call("POST", f"{BASE}/api/v2/video/upload/presign", b"{}")
    call("PUT", pre["uploadUrl"], video_bytes, "video/mp4", signed=False)
    return call("POST", f"{BASE}/api/v3/video/process",
                json.dumps({"objectKey": pre["objectKey"],
                            "capability": "rppg"}).encode())["data"]
```

用法：`data = process(open("face.mp4","rb").read())`，然后取 `data["cardiac"]["hr"]`。

---

## 5. curl 版（排错最快）

```bash
TS=$(date +%s)
SIG=$(printf '%s' "$TS" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
AUTH=(-H "x-key-id: $KEY_ID" -H "x-timestamp: $TS" -H "x-signature: $SIG")

# ①
curl -s -X POST https://www.facephys.com/api/v2/video/upload/presign \
     -H "Content-Type: application/json" "${AUTH[@]}" -d '{}'
# ②
curl -s -X PUT "<uploadUrl>" -H "Content-Type: video/mp4" --data-binary @face.mp4
# ③
curl -s -X POST https://www.facephys.com/api/v3/video/process \
     -H "Content-Type: application/json" "${AUTH[@]}" \
     -d '{"objectKey":"<objectKey>","capability":"rppg"}'
```

---

## 6. 六个坑（官方文档没写，全是实测踩出来的）

### 6.1 必须伪装浏览器 User-Agent ⚠️ 最容易卡住

FacePhys 挂在 **Cloudflare** 后面，默认的 `Python-urllib/3.x` 会被 WAF 直接 403：

```
POST /api/v2/video/upload/presign -> 403: error code: 1010
```

**看起来像签名错了，其实跟签名毫无关系。** 请求里固定带一个 Chrome 的 UA 即可。
`curl` 默认 UA 也可能被拦，显式加 `-A "Mozilla/5.0 ..."`。

### 6.2 `breathing_rate` 拿不到，通常不是字段集问题

`indicators_status` 会把原因写清楚。实测某条视频 22 个 HRV 相关指标**全部** `not_available`：

```json
{"rr": {"status":"not_available",
        "reason":"呼吸率在本次检测中不可用（可能因视频时长不足或算力节点未返回）"}}
```

根因是 `cardiac.hr_list` 为空 → 没有逐拍间期（IBI）→ HRV 整条链算不出来。
**这时候去控制台改 fieldSet 是没用的。** 先看 `hr_list` 长不长。

### 6.3 逐点序列会出现生理上不可能的跳变

实测某条视频的 `hr_list`：

```
ts=20.8  hr=85.1
ts=21.8  hr=117.5     ← 0.9 秒跳 +32.4 bpm
ts=22.7  hr=118.8
```

人从静息到最大心率要几十秒，**1 秒涨 32 bpm 是算法换段产生的伪影**。
而聚合字段 `cardiac.hr = 117.9` 正是被后半段带偏的（前 7 个点都在 85~92）。

**做法**：拿 `hr_list` 算相邻点最大跳变，超过 15 bpm 就判整段不可信，别进基线。
（本项目实现：`HR_MAX_JUMP=15`）

### 6.4 延迟不稳定：9 秒 ~ 36 秒

同一类 30 秒视频，实测 **9.0s**、**12.2s**、**17.0s**、**36.3s** 都出现过。

**不要按"十几秒"设计**。要按 **40 秒**预算，并且业务上必须接受"取证是异步的"。

### 6.5 Token 按秒计费，很贵

| 视频时长 | 扣费 Token |
|---|---|
| 28 秒 | 146,000 |
| 30.5 秒 | 175,000 |

约 **5,700 token / 秒**。100 万额度只够跑 **6 段 30 秒视频**。

**结论：不能做"持续采样"。** 本项目改成「行为信号触发 → 生理信号确认」，
一场面试只采 3~5 次，成本降一个数量级。要用真实数据前务必先算账。

> 官方计费：<15 秒免费。所以短片段试探不一定扣费。

### 6.6 同一条视频，每次结果完全一致

同一个文件重复调用，`hr` 一模一样。这有两个后果：

- 好事：可复现，适合做回归测试
- 坑：拿同一条视频反复"采样"建基线，方差是 0，`MAD=0` 会让任何统计归一化失效
- **模拟基线波动必须用不同视频/真实连拍**，不能靠重复调用

---

## 7. 质量判定：什么数据才能用

### 7.1 sqi 分档（官方口径）

| sqi | 含义 | 怎么处理 |
|---|---|---|
| ≥ 0.30 | 可用 | 正常使用 |
| 0.15 ~ 0.30 | 仅供参考 | **能用但要标"信号偏弱"** |
| < 0.15 | 不可用 | 丢弃 |

⚠️ **实测真实手机视频的 sqi 常在 0.20 上下**。阈值设成 0.25 或 0.5 会把真实数据全部丢掉，
表现为"接口通了、数据回来了，但系统一句话都不说"。

### 7.2 合理性闸门（必做）

```python
if hr is not None and not (40 <= hr <= 180):   # rPPG 会吐 250bpm
    hr, quality = None, 0.0
if rr is not None and not (4 <= rr <= 60):     # 缺数据时返回 0
    rr = None
```

### 7.3 素材自检

拍完先跑一次，三条都过才算合格：

```bash
python tools/check_video.py --video samples/face.mp4
```

```
sqi ≥ 0.30        # 信号质量
max_jump < 10     # 没有伪跳变
rr 不为 None      # 逐拍序列算得出来（可选）
```

**拍摄要点**：光源在正前方、**别逆光**、手机固定、脸占画面 20%+、30 秒、
前 10 秒安静坐着（建基线）后 20 秒说话、拍前静息 2 分钟。

---

## 8. 合规边界（招聘场景尤其重要）

- **不要用 `emotion` 字段做招聘判断**。EU AI Act 第 5(1)(f) 禁止在工作场所使用情绪识别。
- 本项目只取 `hr` / `sqi` / `liveness`，并且：
  - 只算**相对本人基线**的偏离，不看绝对值
  - 必须**生理 + 行为双确认**才输出提示
  - 输出是"追问建议"，**不是评分、不参与自动决策**
- 视频帧**不落盘**，`deleted_media` 天然为真。

---

## 9. 在本项目里怎么接

### 配置（`qiyeduan/backend/.env`）

```ini
VISION_PROVIDER=facephys
TTC_API_BASE=https://www.facephys.com
TTC_API_KEY_ID=<Key ID>
TTC_API_SECRET=<Secret>

MIN_QUALITY=0.15        # 别用默认 0.5，会把真实数据全丢掉
BASELINE_SECONDS=60
BASELINE_MIN_SAMPLES=2  # 视频形态下 60 秒只有 2 个采样，设 8 永远建不起基线
HR_MAX_JUMP=15          # 伪跳变阈值
```

### 切换与验证

```bash
# 1) 签名 + 连通性（不消耗额度）
python tools/probe_facephys.py

# 2) 一条素材体检（消耗一次调用）
python tools/check_video.py --video D:\face.mp4

# 3) 演示想省钱就切回 mock
VISION_PROVIDER=mock
```

### 代码里的对应位置

| 关注点 | 文件 |
|---|---|
| 签名 / 三步流程 / 字段映射 | `vision_facephys.py` |
| 何时采样、背压、预算闸门 | `ws.py`（`on_video_chunk` / `_maybe_request_confirm`） |
| 基线、稳健 z、双确认 | `engine.py` |

---

## 10. 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| `403 error code: 1010` | Cloudflare 拦了 UA | 加浏览器 `User-Agent`（§6.1） |
| `401 invalid API key` | Key ID 认错字符 / 时钟偏移 / 签名原文不对 | 核对 O/0、I/l；`date` 看时间；签名原文是纯时间戳 |
| `422 VIDEO_UPLOAD_INCOMPLETE` | 文件 < 10240 字节 | 上传真实视频 |
| `422 VIDEO_PROCESSING_UNPROCESSABLE` | 不是可解码视频 / 没有脸 | 换标准 MP4，正面人脸 |
| `hr` 有，但 `rr` 一直 null | `hr_list` 为空，HRV 链断了 | 看 `indicators_status.rr.reason`，别改 fieldSet |
| 接口通了但系统不出提示 | `MIN_QUALITY` 太高 / 伪跳变被判死 | 降到 0.15；看 `hr_stats.max_jump` |
| 每次调用结果都一样 | 是同一个文件 | 正常，换视频 |
| 额度掉得飞快 | 一个 30 秒视频 17.5 万 token | 改按需取证，一场 3~5 次 |
