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
python -m unittest discover -s tests -v   # 18 个引擎单测
python tests/smoke_flow.py                # 端到端全链路，不需要 fastapi
```

`smoke_flow.py` 会在几秒内走完：建房间 → 采样 → 封板基线 → 应激 → 双确认 → 出提示 → 反馈 → 报告 → 场次列表。

---

## 2. 目录

| 文件 | 作用 | 改它的频率 |
|---|---|---|
| `engine.py` | **核心算法**：基线 / 稳健 z / 双确认 / 提示生成 | 调阈值时改 |
| `ws.py` | WebSocket 编排 + 背压 + 轮次处理 | 很少改 |
| `vision.py` | 数据源。`MockProvider` 完成度 100%，`RealProvider` 待填 | **你要填的地方** |
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

## 5. 环境变量

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

**demo 前 5 分钟要改的通常只有两个**：`BASELINE_SECONDS` 和 `MOCK_STRESS_WINDOWS`。

---

## 6. 待填清单（按优先级）

| # | 事项 | 文件 | 为什么急 |
|---|---|---|---|
| 1 | `RealProvider.sample()` 对接真实 API | `vision.py` | 决定 demo 是真是假。字段名按对方文档改，**拿不到 quality 就返回 0** |
| 2 | 压测延迟：单次调用多久？ | — | >3s 就要把「轮次级提示」降级为「整段报告」 |
| 3 | `beh` 四个字段由谁算？ | 契约 | 如果候选人侧不算，就得在后端用 STT 时间戳算 `speech_rate_drop` / `pause_ratio` |
| 4 | 报告摘要接 LLM | `report.py` | 优先级最低，模板已经能看 |

---

## 7. 交给前端之前的验收清单

- [ ] `python tests/smoke_flow.py` 打印「全链路通过」
- [ ] `/api/rooms` 建房间返回 6 位房间号
- [ ] 候选人 WS 连上后，面试官收到 `peer: online`
- [ ] 基线期 `signal` 里 `baseline_ready=false` 且 `baseline_remaining` 在倒数
- [ ] 基线期**绝不产生 `hint`**（这是合规红线）
- [ ] 正常轮次不产生 `hint`（静默是常态）
- [ ] 双异常轮次 3 秒内产生 `hint`
- [ ] 点「用掉」后收到 `hint_ack` 且 `adopt_rate` 变化
- [ ] 结束后面试官收到 `report_ready`，`points` ≤ 3
- [ ] 报告里**没有任何 score / rank 字段**
- [ ] 视频 API 挂掉时，面试官收到 `status: degraded` 而不是断线

---

## 8. 三个坑（已经踩过并处理，别改回去）

1. **候选人 5fps 上报，云端 API 要 1–2s。** 如果排队，队列会无限增长，提示延迟从 2 秒变 20 秒。`ws.py` 用的是「覆盖写入 + Event」，永远只处理最新帧，旧帧直接丢。**不要改成 `asyncio.Queue`。**
2. **视觉 API 必须 `asyncio.to_thread`。** 同步 HTTP 会卡死事件循环，整条管道一起僵。
3. **基线未就绪时不许出任何提示。** `judge_turn` 第一道闸门就是这个，`Baseline.remaining()` 给前端倒计时用。别为了 demo 好看把这个门去掉——那是全项目唯一的合规叙事。
