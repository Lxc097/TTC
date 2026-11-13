# TTC 真实面试候选人端

此目录是 TTC 企业面试的独立候选人页面，**不是** `gerenduan/` 的模拟面试项目。页面直接使用企业后端的真实房间、WebSocket 与候选人报告，不创建演示房间或编造分析结果。

本地运行：

```powershell
cd qiyeduan/backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

打开 `http://127.0.0.1:8000/classic/` 创建房间，再通过页面生成的 `/personal/?room=房间号` 邀请链接进入。候选人须明确选择是否同意画面分析；麦克风和摄像头分别由本人主动开启，核实视频片段需再次逐次确认。面试官结束房间后，候选人报告会显示真实发言摘录、表达建议和本场纪要；缺少转写时明确显示分析依据不足。

面试官端可以看到候选人**主动开启**的摄像头画面：浏览器按 ~5fps 上报帧，服务端只把最近一帧实时转发给面试官（默认限流到 4fps），不录制、不落盘、不进报告；候选人关闭摄像头或断开连接后画面立即停止。这里没有双向音视频通话，候选人也听不到面试官的声音。旧企业端场次与报告接口仍无角色鉴权，房间号也不是完整的身份认证机制；只宜本地联调，勿用真实候选人数据直接公开部署。

## 在另一台设备恢复 API 配置

1. 从 GitHub 获取代码后，把 `qiyeduan/backend/.env.example` **复制**为同目录的 `.env`。不要改动或填写 `.env.example`。
2. 通过私下的安全渠道取得原本保存在 `KEYS.local.md` 的值，**只写入该设备的 `.env`**：`TTC_API_KEY_ID`、`TTC_API_SECRET`、`TTC_API_BASE`、`LLM_API_KEY`、`STT_API_KEY`。模型和服务地址可按实际服务商配置填写。不要把 `KEYS.local.md` 复制进仓库。
3. 平时联调保持 `VISION_PROVIDER=mock`；确需真实画面分析才改为 `facephys`。需要语义分析或语音转写时分别设置 `LLM_ENABLED=1`、`STT_ENABLED=1`，并确保对应 key 已填。
4. 在 `qiyeduan/backend` 安装 `requirements.txt` 并启动 `uvicorn main:app --host 127.0.0.1 --port 8000`，打开 `/classic/` 与 `/personal/`。服务器上的 `.env` 建议设为仅服务进程可读（例如 Linux `chmod 600`）。

`.env`、`*.local.md` 和虚拟环境都由 `.gitignore` 排除。仓库只保留不含真实凭据的变量名与接口代码；这些代码不能代替服务端角色鉴权。
