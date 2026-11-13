# 面试官后端 · 耳语

你负责的这一块。边界：**房间 + 会话 + 生理管道 + 判题引擎 + 提示推送 + 报告 + 场次列表**。
候选人上报的帧和轮次也走这个后端（同端点不同 role），所以你和候选人侧同学的唯一耦合就是这个契约。

算法部分已经跑通并有测试，`VISION_PROVIDER=mock` 时**不需要真实 API 就能全流程演示**。

---

## 1. 跑起来（3 分钟）

```bash
cd qiyeduan/backend
pip install -r requirements.txt

# demo 用假数据（推荐先跑这个）
set VISION_PROVIDER=mock
uvicorn main:app --reload --port 8000
```

打开 <http://127.0.0.1:8000> —— 这是**自测台**，不需要等前端：

1. 点「创建房间」→ 拿到 6 位房间号
2. 点「连接双方」→ 同时以面试官和候选人身份接入
3. 点「开始上报画面」→ 信号带开始有颜色
4. 等 20 秒（基线期）→「开始回答」→ 10 秒后「回答结束」
5. 右侧「停顿占比」拉到 0.8 再点结束 → 立刻弹提示卡
6. 「用掉」→「结束面试 → 看报告」

> 自测台默认走 demo 参数，想更快就把 `BASELINE_SECONDS` 调到 12、`MOCK_STRESS_WINDOWS` 调小。

### 验证

```bash
python -m unittest discover -s tests -v   # 49 个（18 引擎 + 6 管道 + 10 解析 + 15 配置）
python tests/smoke_flow.py                # 端到端全链路，不需要 fastapi
python tools/probe_vision_api.py --self-test   # 真实 API 适配层自检
```

`test_pipeline.py` 专门盯三类「测试全绿但其实已经坏了」的问题：背压丢帧产生空帧假样本、
worker 泄漏、候选人未授权却仍在分析。`test_vision_http.py` 盯厂商返回的各种奇葩结构。

`smoke_flow.py` 会在几秒内走完：建房间 → 采样 → 封板基线 → 应激 → 双确认 → 出提示 → 反馈 → 报告 → 场次列表。

---

## 2. 目录

| 文件 | 作用 | 改它的频率 |
|---|---|---|
| `engine.py` | **核心算法**：基线 / 稳健 z / 双确认 / 提示生成 | 调阈值时改 |
| `ws.py` | WebSocket 编排 + 背压 + 轮次处理 | 很少改 |
| `vision.py` | 数据源选择器 + `MockProvider`（可排练的假数据） | 很少改 |
| `vision_http.py` | **真实 API 适配层**：A/B 两种形态 + 字段映射 + 合理性闸门 | 接 API 时看 |
| `tools/probe_vision_api.py` | 接入探针：跑它比读文档快，先跑再写代码 | — |
| `report.py` | 报告生成，模板兜底 + 可选 LLM | 改文案时改 |
| `store.py` | 内存状态（房间/会话/提示） | 加字段时改 |
| `api.py` / `main.py` | 路由与装配 | 加接口时改 |
| `static/dev_candidate.html` | 自测台 | 联调时改 |
| `tests/` | 单测 + 全链路冒烟 | 改算法必跑 |

---

## 3. 接口契约（和前端/候选人侧对齐用）

### REST

| 方法 | 路径 | 谁用 | 说明 |
|---|---|---|---|
| POST | `/api/rooms` | 面试官 | 创建房间，body `{job_title?, questions?}` → `{code, ...}` |
| GET | `/api/rooms/{code}` | 面试官等待页 | 房间状态、对端是否在线、基线是否就绪 |
| POST | `/api/rooms/{code}/end` | 面试官 | 结束并生成报告 |
| GET | `/api/interviews` | 面试官 | **场次**列表（不是候选人排名） |
| GET | `/api/sessions/{sid}/report?role=` | 两侧 | `role=candidate` 返回候选人版文案 |
| POST | `/api/hints/{hint_id}/feedback` | 面试官 | WS 断线时的兜底，body `{action:"used"\|"ignored"}` |
| GET | `/api/config` | 前端 | 基线时长、阈值，用于渲染「建立基线中」 |
| GET | `/healthz` | 运维 | 健康检查 |

### WebSocket

`ws://host/ws/room/{code}?role=interviewer|candidate&consent=0|1`

**候选人 → 服务端**

| type | 字段 | 说明 |
|---|---|---|
| `frame` | `t`, `img`(dataURL) | 5fps，建议 320px 宽、JPEG 0.6 |
| `turn_start` | `t` | 开始回答 |
| `turn_end` | `t`, `transcript`, `beh{}` | 结束回答，`beh` 见下 |
| `end` | `t` | 结束整场 |

`beh` 四个字段全部归一化到 0..1：`pause_ratio` / `filler_density` / `speech_rate_drop` / `gaze_off`。
**拿不到就留 0，不要瞎填** —— 留 0 表示"未知"，引擎不会因此误报。

**服务端 → 面试官**

| type | 说明 |
|---|---|
| `signal` | 每 ~2s 一条：`t, load_z, hr, quality, face_count, baseline_ready, baseline_remaining` |
| `turn_summary` | 轮次结算：`phys_peak, phys_mean, beh_anomaly` |
| `hint` | **核心**：`id, kind(probe\|upgrade\|wrap), text, why, t` |
| `hint_ack` | 反馈回执：`action, adopt_rate` |
| `peer` | 对端上线/下线 |
| `status` | `degraded` 降级通知 |
| `report_ready` | 整份报告 |

> 所有消息都带 `t`（相对面试开始的秒数）。前端只按 `t` 对齐，不按本地时钟。

---

## 4. 算法三条纪律（评审会问，背下来）

1. **不看绝对值，只看相对本人基线的偏离。** 摄像头 rPPG 的绝对心率会被光照和肤色毁掉，但"这个人比他自己刚才更费力"是可靠的。
2. **双确认：生理 ∧ 行为，缺一静默。** 单一生理信号异常一律不出提示。宁可漏报不可误报——面试官被误报坑一次就再也不用了。
3. **提示确定性生成，不用随机。** 同一个 `turn_id` 永远出同一条文案，否则 demo 没法排练。

另外两个容易被问到的实现细节，都是有意为之：

- `robust_z` 用 **MAD（中位数绝对偏差）** 而不是标准差。rPPG 序列一定带尖刺，标准差会被单点拉爆。
- `Behavior.anomaly()` 用 **0.6×最强通道 + 0.4×平均**，不是纯平均。纯平均会让一个 0.8 的强信号被其他三个正常通道稀释掉（这个 bug 是跑冒烟测试时抓到的）。

---

## 5. 接真实 API —— 你唯一必填的活

适配层已经写好了，**绝大多数情况下你不需要改代码，只改环境变量**。

### 第 0 步：先判断你们是哪种形态

| 形态 | 特征 | `VISION_API_MODE` |
|---|---|---|
| **A 帧级同步** | POST 一张图 → 立刻返回心率 | `frame`（默认） |
| **B 片段** | POST N 秒视频 / 多帧 → 返回结果 | `segment` |
| **C 流式 WS** | 长连接持续吐数据 | 需改 `ws.py`，见 `vision_http.py` 末尾 |

**B 形态有一个陷阱，不知道会通宵**：rPPG 需要连续帧，而我们的背压为了控制延迟只保留最新一帧。
如果照搬，每 2 秒才喂一帧，视频被打散，心率永远算不对。
所以 segment 模式下帧缓冲放在**落帧那一侧**（`ws.py` 的 `seg_buffer`），不是一个可选项。

### 第 0.5 步：密钥放 `.env`，永远不要放代码

```bash
copy .env.example .env      # 然后填 VISION_API_URL / VISION_API_KEY
```

`.env` 已被 `.gitignore` 排除，由 `config.py` 里的 20 行解析器自动加载（不引入
python-dotenv 依赖），且**真实环境变量优先**——现场用 `set` 临时覆盖依然生效。

> ⚠️ 不要把密钥写进代码、README、测试、commit message，也不要贴进任何会被记录的地方。
> 仓库只要有一个人 `git add .`，密钥就跟着历史记录永久留在那里了（删掉文件也没用，
> 要 `git filter-repo` 重写历史 + 立刻去平台轮换）。

### 第 1 步：先跑探针，别急着写代码

```bash
python tools/probe_vision_api.py --self-test          # 自检适配层（不需要网络）
set VISION_API_URL=https://vendor.example.com/v1/physio
set VISION_API_KEY=sk-xxxx
python tools/probe_vision_api.py --image samples/face.jpg --times 5
```

它会一次告诉你四件事：**原始响应长什么样、被映射成了什么、延迟多少、延迟是否满足 <3s**。
自检模式已经验证过：本地假服务 `78ms`，`hr=78.2 rr=16.1 quality=0.91 faces=1`，映射正确。

### FacePhys 特别注意（这是视频形态，不是逐帧）

判据：`VISION_PROVIDER=facephys`。代码在 `vision_facephys.py`，接口来自官方 v3 文档。

**已实测通过**（用官网演示视频跑的真实全链路）：

```
lie2meInnocent.mp4   hr=102.06  sqi=0.384   12.2s
lie2meCriminal.mp4   hr=66.42   sqi=0.310   17.0s
```

**实测出来的三条硬约束，会改变产品设计：**

1. **单次 12–17 秒，不是 3 秒。** 一段 30 秒视频送上去，要等 12~17 秒才出结果。
   「回答结束后 3 秒内给提示」在这个 API 上**不成立**。
   可行的形态：改成「最近 1~2 分钟的整体负荷趋势」，每 30 秒出一个点，提示滞后约 20 秒。
   这其实更符合生理学——心率响应本身就有 5~15 秒滞后，逐句话出信号反而是假精确。
2. **返回值是单点采样，没有时间序列。** 一次调用 = 一个 hr + 一个 sqi，不是每秒一帧。
   所以 `phys_peak`（一轮内的峰值）只有在同一轮里打过 2 个以上视频块时才有意义。
3. **Token 消耗要算账。** 实测后余额 854,000。如果起始是 100 万，那 2~3 次调用
   就用掉了约 15 万，**单次约 5 万 token**，只够再跑十几次。
   现场 demo 千万别拿它当"持续分析"用，要按次预算，并留足备用。

**鉴权**（HMAC-SHA256，±300 秒窗口）：

```python
x-key-id    = key_id
x-timestamp = str(int(time.time()))
x-signature = base64(HMAC_SHA256(secret_key, timestamp))
```

**三步流程**：`POST /api/v2/video/upload/presign` → `PUT uploadUrl`（Content-Type: video/mp4）
→ `POST /api/v3/video/process` `{objectKey, capability:"rppg"}`。
返回 `data.cardiac.{hr, sqi, hrv}`、`data.breathing_rate`、`data.tokens_deducted`。

**四个必须知道的约束**：

1. **采样下限 15 秒，最好 30 秒。** 一个视频块换一个采样点，不可能"每 2 秒一个点"。
   所以提示节奏从「每轮」变成「每 30 秒」。`wrap`（连续两轮高负荷）逻辑仍然成立，
   但 `probe` 的响应会慢一个块（约 30 秒 + 处理时间）。
2. **`User-Agent` 必须伪装成浏览器。** FacePhys 挂在 Cloudflare 后面，默认的
   `Python-urllib/3.x` 会被 WAF 直接 403，响应体是 `error code: 1010`。
   看起来像签名错，其实跟签名没关系——`BROWSER_UA` 常量钉住了这一点。
3. **`sqi` 阈值是 0.30，不是 0.5。** 官方文档：`sqi >= 0.30` 即可用。实测两段视频
   的 sqi 只有 0.31 / 0.38，沿用默认 `MIN_QUALITY=0.5` 会把全部有效数据丢掉。
   视频形态必须设 `MIN_QUALITY=0.25`。
4. **基线要少采几个点。** 60 秒基线在视频形态下只有 2 个采样，`BASELINE_MIN_SAMPLES=8`
   永远不满足。视频形态建议 `BASELINE_SECONDS=60` + `BASELINE_MIN_SAMPLES=2`。

候选人侧要配合的地方：浏览器用 `MediaRecorder` 每 ~30 秒切一段，走
`{"type":"video_chunk","t":<秒>,"data":"<base64>","ct":"video/webm"}` 发上来。
格式支持 MP4 / MOV / AVI / WebM，分辨率 ≥ 640×480，正面人脸占画面 20% 以上。



默认已经覆盖最常见的几十种命名（`data.heart_rate` / `hr` / `result.physio.bpm` …），
命不中就用 `|` 分隔多个候选路径：

```bash
set VISION_FIELD_HR=result.physio.bpm|data.hr
set VISION_FIELD_QUALITY=data.signal.score
```

路径支持数组，会自动取**最后一个**元素（厂商常返回逐帧数组）。

### 第 3 步：三道闸门必须真的生效

- **`quality` 拿不到时不要瞎猜。** 现在的规则是：有人脸 + 有心率才给 0.8，否则 0。宁可静默。
- **生理合理性闸门**：HR 不在 `40-180`、RR 不在 `4-60` 一律判无效（rPPG 会吐 250bpm）。
- **多人脸直接 `quality=0`**：画面里不止一个人时基线不可用，这一条别放宽。

### 第 4 步：压延迟，这是唯一的技术生死线

探针跑完看 avg：

| 平均延迟 | 结论 |
|---|---|
| < 1s | 直接做逐轮提示，体验最好 |
| 1–3s | 仍然成立（我们的产品形态本来就是"回答结束后 3 秒内给建议"） |
| > 3s | 降级成整场结束后的报告，叙事不变，只少了实时感 |

`VISION_TIMEOUT` 默认 2.5s，别设太大——超时比慢更可控，超时会走 degraded 降级而不是卡死。

### 最后：切换数据源

```bash
set VISION_PROVIDER=real
```

一个环境变量的事。**demo 现场 API 挂了就切回 `mock`，前台看不出来。**

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VISION_PROVIDER` | `mock` | `mock` / `real` |
| `BASELINE_SECONDS` | `60` | 基线窗口，demo 建议 12–20 |
| `BASELINE_MIN_SAMPLES` | `8` | 基线最少样本，样本不够会自动顺延窗口 |
| `SAMPLE_MIN_INTERVAL` | `2.0` | 两次调 API 的最小间隔（省额度、省延迟） |
| `PROBE_THRESHOLD` | `1.5` | 生理偏离阈值（σ） |
| `BEHAVIOR_THRESHOLD` | `0.5` | 行为异常阈值 |
| `HINT_COOLDOWN` | `30` | 两条提示最小间隔（秒），防刷屏 |
| `MOCK_STRESS_WINDOWS` | `25-40,85-100` | mock 模式下模拟负荷升高的时间窗 |
| `LLM_ENABLED` | `0` | 开启后报告摘要走 LLM，失败自动降级模板 |
| `MIN_QUALITY` | `0.5` | 低于此质量的数据直接丢弃 |
| `VISION_API_URL` | — | 真实 API 地址（`VISION_PROVIDER=real` 时必填） |
| `VISION_API_KEY` | — | 鉴权用，默认放 `Authorization: Bearer <key>` |
| `VISION_API_MODE` | `frame` | `frame` 单帧 / `segment` 片段 |
| `VISION_PAYLOAD` | `json_b64` | `json_b64` / `json_b64_list` / `raw` |
| `VISION_TIMEOUT` | `2.5` | 单次请求超时（秒），超时会降级而非卡死 |
| `VISION_SEGMENT_SECONDS` | `12` | segment 模式的送检窗口长度 |
| `VISION_FIELD_HR/RR/QUALITY/FACES` | 内置候选 | 字段路径，`\|` 分隔多个候选 |
| `VISION_HR_RANGE` | `40-180` | 心率合理性区间，超出即判无效 |
| `VISION_RR_RANGE` | `4-60` | 呼吸率合理性区间 |
| `VISION_AUTH_HEADER` | `Authorization` | 鉴权头名，部分厂商用 `X-Api-Key` |
| `VISION_AUTH_PREFIX` | `Bearer ` | 鉴权前缀，不需要就设成空 |

**demo 前 5 分钟要改的通常只有两个**：`BASELINE_SECONDS` 和 `MOCK_STRESS_WINDOWS`。

---

## 7. 待填清单（按优先级）

| # | 事项 | 文件 | 为什么急 |
|---|---|---|---|
| 1 | 跑 `tools/probe_vision_api.py` 打真实 API | `vision_http.py` | 见 §5，通常只改环境变量，不用改代码 |
| 2 | 压测延迟：单次调用多久？ | — | >3s 就要把「轮次级提示」降级为「整段报告」 |
| 3 | `beh` 四个字段由谁算？ | 契约 | 如果候选人侧不算，就得在后端用 STT 时间戳算 `speech_rate_drop` / `pause_ratio` |
| 4 | 报告摘要接 LLM | `report.py` | 优先级最低，模板已经能看 |

---

## 8. 交给前端之前的验收清单

- [ ] `python tests/smoke_flow.py` 打印「全链路通过」
- [ ] `/api/rooms` 建房间返回 6 位房间号
- [ ] 候选人 WS 连上后，面试官收到 `peer: online`
- [ ] 面试官刷新/重连后收到 `snapshot`，历史提示还在
- [ ] 基线期 `signal` 里 `baseline_ready=false` 且 `baseline_remaining` 在倒数
- [ ] 基线期**绝不产生 `hint`**（这是合规红线）
- [ ] 正常轮次不产生 `hint`（静默是常态）
- [ ] 双异常轮次 3 秒内产生 `hint`
- [ ] 点「用掉」后收到 `hint_ack` 且 `adopt_rate` 变化
- [ ] 结束后面试官收到 `report_ready`，`points` ≤ 3
- [ ] 结束后面试官收到的是「面试质量报告」，候选人是「3 个收获」两份不同文案
- [ ] 报告里**没有任何 score / rank 字段**
- [ ] **候选人 `consent=0` 时**：面试官收到 `status: no_consent`，且**一条 `signal` 都没有**
- [ ] 视频 API 挂掉时，面试官收到 `status: degraded` 而不是断线
- [ ] 结束面试后 5 秒，日志里不应再出现视觉 API 调用（worker 已停）

---

## 9. 六个坑（已经踩过并处理，别改回去）

1. **候选人 5fps 上报，云端 API 要 1–2s。** 如果排队，队列会无限增长，提示延迟从 2 秒变 20 秒。`ws.py` 用的是「覆盖写入 + Event」，永远只处理最新帧，旧帧直接丢。**不要改成 `asyncio.Queue`。**
2. **视觉 API 必须 `asyncio.to_thread`。** 同步 HTTP 会卡死事件循环，整条管道一起僵。
3. **基线未就绪时不许出任何提示。** `judge_turn` 第一道闸门就是这个，`Baseline.remaining()` 给前端倒计时用。别为了 demo 好看把这个门去掉——那是全项目唯一的合规叙事。
4. **`latest_frame` 只能在取帧时清空，不能在 `sleep` 之后清空。** 放错位置会把睡眠期间到达的新帧覆盖成 `None`，下一轮处理空帧时产出一条 `quality=0` 的假样本，把基线和报告一起污染。（`test_frame_arriving_during_sleep_is_kept` 钉住这一点。）
5. **`session.consent` 是硬闸门，不是 UI 提示。** 未授权时连视觉 API 都不许调；`test_no_analysis_without_consent` 用计数 provider 验证调用次数为 0。
6. **`cancel()` 不等于停。** 结束面试必须 `await hub.stop()` 等任务真的结束，否则"报告发出去的时候分析还在跑"，长跑必泄漏。
