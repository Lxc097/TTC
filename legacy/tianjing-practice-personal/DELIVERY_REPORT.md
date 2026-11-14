# 天镜 Practice · 个人端交付报告

> 交付日期：2026-11-14。本文供下一位开发者及其 AI 助手接手，描述当前代码，而非未来设想。项目是黑客松个人端 Demo；企业端音视频房间尚未实现。任何实际摄像头、浏览器语音和第三方账号的可用性都应在目标机器复验。

## 1. 产品方向与边界

天镜 Practice 面向面试者，核心闭环是“指定岗位和经历 → 检查设备 → AI 提问/追问 → 语音或文字回答 → 逐题复盘 → 本地历史”。问题生成和回答总结优先由硅基流动上的 DeepSeek 完成；服务缺失或失败时保留本地题库与可解释规则，让演示能够继续。摄像头预览必须使用真实 MediaStream；FacePhys 只在用户明确同意后分析视频片段。生理数据与回答能力评分分开呈现，不把心率变化写成紧张、自信、诚信或心理诊断结论。

本仓库只包含个人端。真实面试入口当前是等待室演示流程，不表示已经与企业端连通；没有登录、数据库、WebRTC 双向通话或生产部署配置。

## 2. 当前已实现的用户路径

1. 首页（/）：品牌介绍、模拟面试、历史记录和真实面试入口。
2. 配置（/setup）：自由填写目标岗位和面试重点；选类型、基础/标准/挑战难度、5/10/15 分钟；可选上传 PDF、DOCX、TXT 简历。浏览器提取简历文字，向 AI 出题服务传入至多 8,000 字；原文件不入历史记录。
3. 设备检测（/device-check）：浏览器 getUserMedia 请求真实摄像头、选择设备、预览和关闭；麦克风权限与输入电平检测；可选纯文字/仅打字；单独选择是否授权视频分析，确认后继续。
4. 面试间（/interview）：AI 舞台、真实摄像头画中画、题目、对话和可编辑转写、文字提交、语音按钮、倒计时、麦克风/摄像头控制、静音、自动完成开关、跳题和提前结束。题目和追问按真实状态机推进，避免同一轮重复提交。
5. 报告（/report/:id）：基本信息、基于实际回答的文本评分和逐题建议、回答时间轴及最终转写事件；独立展示真实 FacePhys 采样与服务端脱敏后的原始 data JSON，异步分析完成后可更新。无有效数据时明确提示，不补造曲线。
6. 历史（/history）：浏览器 localStorage 最多保存最近 100 条记录；可查看报告、删除和重新练习。
7. 加入面试（/join、/waiting）：输入房间号和昵称，经过设备检测进入演示等待室；明确标识尚未连接企业端。

## 3. 工程结构与职责

| 位置 | 职责 |
| --- | --- |
| src/App.tsx、src/pages/ | React Router 路由与各页面；面试和报告按路由懒加载。 |
| src/components/interview/room/ | AI 舞台、头像、题目、实时转写、控制栏、设备状态、退出确认等视觉组件。 |
| src/components/camera/CameraManager.tsx | 集中持有摄像头流；设备页与面试页之间复用轨道，切换/离开时释放。 |
| src/components/interview/AudioWaveform.tsx、src/hooks/useInterviewAudio.ts | 麦克风音量波形、浏览器 ASR/TTS、可播放音频的分析节点与生命周期。 |
| src/hooks/interviewFlow.ts、src/pages/InterviewSession.tsx | 面试阶段 reducer 与会话编排、回答提交、追问、FacePhys 采样关联。 |
| src/data/questions.ts、src/data/difficultyProfiles.ts | 五类岗位本地题库与难度策略；基础最多追问 1 次，标准和挑战最多 2 次。 |
| src/services/interviewClient.ts、src/services/interviewEngine.ts | 同源 AI 代理客户端与本地题库/追问降级。 |
| server/index.ts、server/questionPlan.ts、server/siliconflow.ts | Node 同源代理、会话/追问次数校验、结构化出题、OpenAI 兼容请求。 |
| src/services/biometrics/、server/facephys.ts | 浏览器视频分段、服务端 FacePhys 签名/预签名上传/V3 分析与结果映射。 |
| src/utils/ | 简历提取、ASR 片段合并/纠错、自动完成条件、文本报告、历史存储。 |
| src/services/rooms.ts、src/types/interviewRoom.ts | 企业房间的演示适配器和待联调数据结构。 |
| tests/、scripts/siliconflow-smoke.ts | 本地测试与可选的单次真实模型冒烟脚本。 |

整体采用 React 19 + TypeScript + Vite 8；小型 Node HTTP 代理与前端同仓运行，Vite 将 /api 转发至本机 8787 端口。页面色系已统一为奶油白底、橙色操作强调及深灰文字。未引入数据库或重型服务框架。

## 4. AI 问题和回答处理

### 4.1 出题

server/questionPlan.ts 把目标岗位、类型、难度、可选重点与简历提取文本整理进提示词，请求指定模型返回严格 JSON 题目数组及 2–4 个主题词。解析器要求数量正确、题目不重复且字段有效；失败会返回明确提示并切换本地题库。五类岗位的本地题库支持无密钥演示。时长决定题目计划规模；难度同时影响提问说明、追问策略和服务器端追问次数上限。

硅基流动适配在 server/siliconflow.ts。默认 Base URL 为 https://api.siliconflow.cn/v1，默认模型 ID 为 deepseek-ai/DeepSeek-V4.1-Flash；都可由环境变量覆盖。密钥只由 Node 进程读取。浏览器不直接向模型供应商发请求。模型下线、认证失败、限流或过载会给出可读错误并由客户端降级。

### 4.2 回答与追问

文字框可直接输入并提交。语音识别使用浏览器 SpeechRecognition/webkitSpeechRecognition，显示 interim 临时字幕并保存 final 片段；人工编辑后的新识别片段须经用户合并，最终回答按原文保存，不在下一题之前清空。提交时将当前回答、题目、时间、输入方式和已确认转写事件保存为一轮记录。AI 模式可请求 DeepSeek 根据真实回答给出简短总结及动态追问；无效/过短回答和服务故障使用本地确定性总结与追问规则。服务端依据会话和题目 ID 验证追问次数，并限制重复提交与请求规模。

浏览器 SpeechSynthesis 负责朗读问题；播放结束或失败后才进入收音流程。自动完成默认关闭，开启后要求至少 12 秒回答、8 秒静音且有有效文本，再给 2 秒可取消倒计时。ASR 不支持、无文本、权限拒绝、网络服务异常时，用户仍可纯文字答题。

### 4.3 报告

src/utils/report.ts 使用最终回答实际内容、题目主题词与表达结构计算可解释文本分数：完整度 40%、主题词覆盖 35%、结构 25%。空白、极短或无证据回答不会得到无依据的高分或能力结论。逐题建议、综合复盘和回答时间轴保留全部已提交回答；DeepSeek 的每题总结与本地规则总结有来源标识。FacePhys 采样从不计入文本分数。

## 5. 摄像头、语音和 FacePhys 的真实能力

**摄像头。** CameraManager 调用真实 navigator.mediaDevices.getUserMedia，目标采集分辨率 1280×720。PiP 只改变显示尺寸，复用原轨道；关闭、切换设备、结束或离开相应路由时 stop 视频轨道。无设备或权限被拒绝可选择纯文字面试。物理摄像头能否使用取决于目标电脑和浏览器权限，自动化测试不能代替现场实测。

**语音。** 麦克风输入电平和绿色波形取自真实 MediaStream + Web Audio AnalyserNode。浏览器自带的 SpeechSynthesis 不暴露可测播放流，因此目前浏览器朗读阶段不伪造蓝色音频波形；useInterviewAudio.speak(text, { audioUrl }) 已预留未来 TTS 音频驱动的真实波形。Web Speech 的可用性及是否依赖浏览器网络服务因浏览器而异；应用内的麦克风选择用于电平采集，SpeechRecognition 可能仍使用系统默认输入设备。

**FacePhys。** 仅在用户授权、摄像头存在且服务端凭据已配置时启动。前端 MediaRecorder 采集约 30 秒 MP4/WebM 视频段，不足 15 秒的段不上传；面试中最多启动 5 段，上一段分析结束后才开始下一段。server/facephys.ts 按预签名 → PUT 视频 → /api/v3/video/process（rppg）处理，并脱敏返回的 data；未写入真实凭据。结果具有批处理延迟，不能宣称逐帧实时。映射已返回的估计心率、信号质量及可用扩展指标；当前映射不制造“情绪分类”字段。每题反应是与自身早期有效采样比较后的谨慎提示，不能据此断定“紧张”或“自信”。报告保留结果来源、时间与脱敏原始 JSON，以便核对 API 实际输出。

FacePhys 的代码适配和模拟响应测试已完成；**这不等于在本次交付中证明了真实账号、真实摄像头和供应商服务端的端到端成功**。接入正式凭据后，应在用户同意的真实浏览器里验证服务状态、视频上传和返回字段。 当前服务端对象存储上传使用供应商示例的固定 video/mp4 Content-Type；若目标浏览器只录出 WebM，须实测供应商是否接受，否则调整录制格式或增加受控转换。

## 6. 数据、隐私与安全边界

- 面试记录保存在当前浏览器 localStorage，包含题目、最终回答、最终转写事件、文本分析及可能的 FacePhys 脱敏结果；不保存原始视频。删除记录只删除该浏览器的本地副本。
- 简历原文件在浏览器本地提取；提取的文本仅作为当前会话草稿，并在 AI 出题时发送给本机代理及已配置的模型供应商。保存报告时移除 resumeText。请勿把真实敏感简历用于公开演示。
- 服务端内存保存 AI 会话和题目校验状态，重启后失效；无账号或多用户隔离。这是本地 Demo，不应原样部署为对公网开放的招聘系统。
- API 凭据只从服务端环境变量读取；前端接口使用同源 /api。错误信息和 FacePhys 原始 data 会做凭据/传输字段脱敏。不要把 .env.local、真实密钥、用户简历或浏览器存储导出加入公开仓库。
- 未同意画面分析时，不请求 FacePhys；历史 Mock 记录有来源标记，正式报告不把演示数值混成真实采样。

单独的本地安全说明保存在本机 LOCAL_SECURITY_NOTES.md，**不应复制到公开仓库**。公开的 .env.example 只列非密钥项及密钥名称说明，不包含凭据值。

## 7. 启动、环境配置与接口

需要 Node.js、npm、摄像头/麦克风权限。项目根目录运行：

~~~powershell
npm install
npm run dev
~~~

浏览器打开终端显示的 Vite Local 地址，通常为 http://127.0.0.1:5173/。前端和本地 API 同时启动；代理默认只监听 127.0.0.1:8787。摄像头和麦克风权限请在 localhost 或 HTTPS 下测试。环境变量名称：

| 变量 | 作用 |
| --- | --- |
| SILICONFLOW_API_KEY | 可选；真实 DeepSeek 请求的服务端密钥。缺失时面试自动使用本地题库/总结。 |
| SILICONFLOW_BASE_URL | 可选；OpenAI 兼容 Base URL，必须以 /v1 结尾。 |
| SILICONFLOW_MODEL | 可选；目标模型 ID，换模型只需修改该变量并确认平台在售。 |
| FACEPHYS_KEY_ID、FACEPHYS_SECRET_KEY | 可选；仅服务端使用，二者齐备后才允许真实视频分析。 |
| FACEPHYS_BASE_URL | 可选；FacePhys HTTPS 地址。 |
| INTERVIEW_API_PORT | 可选；本地 API 端口，修改时还须同步 vite.config.ts 的 /api 代理目标。 |

不要把密钥写入仓库文件；在运行终端设置环境变量后启动即可。更多本机安全输入方式见 README.md。接口约定：

| 接口 | 当前用途 |
| --- | --- |
| GET /api/interview/status | 返回 AI 是否配置、当前 provider 和模型 ID。 |
| POST /api/interview/sessions | 校验配置并生成题目；返回 siliconflow 或 local 模式。 |
| POST /api/interview/follow-ups | 按会话、题目和当前追问次数生成追问。 |
| POST /api/interview/answer-summary | 根据有效回答生成 DeepSeek 或本地总结。 |
| DELETE /api/interview/sessions/:id | 释放服务端会话。 |
| GET /api/biometrics/status | 返回 FacePhys 是否配置、是否已有成功分析、采集方式。 |
| POST /api/biometrics/analyze | 授权后的视频片段分析代理，当前接受 MP4/WebM。 |

真实房间服务后续应对接 src/services/rooms.ts 中的 joinInterviewRoom()、getInterviewRoomStatus()、leaveInterviewRoom()，并确定房间号/昵称格式、认证、状态与错误码、面试官进入事件、实时订阅、信令、ICE/TURN 和断线恢复。当前 demo_waiting 只代表演示等待，**不代表真实连接成功**。

## 8. 本次交付检查与未验证项

2026-11-14 在本地项目根目录执行：npm run build 成功（包含 TypeScript 构建与 Vite 生产打包）；npm run typecheck 成功；npx tsc -p tsconfig.server.json --noEmit 成功；npm run lint 成功；npm test 为 **21/21 通过**。测试覆盖题目计划、面试状态机、自动完成、ASR final/interim 合并、文本评分、SiliconFlow 请求与错误映射、FacePhys 无授权不联网、V3 流程映射及 Mock 数据隔离。测试中的供应商请求使用模拟响应，不是线上付费调用。

本次交付没有声称验证：目标机器的物理摄像头、各外部浏览器的 SpeechRecognition 与朗读输出、正式 SiliconFlow 账号的模型额度、真实 FacePhys 凭据/上传链路、企业端房间服务。建议现场按“配置 → 设备检测 → 纯文字完成一场 → 报告/历史 → 真实摄像头/麦克风 → 真实 AI → 明确授权的 FacePhys 视频”顺序验收，以便逐步定位失败环节。

## 9. 下一位开发者的优先事项

1. 在本地配置可用模型与 FacePhys 凭据，先检查两个 /api/*/status，再各做一次短而真实的端到端验证；不要把请求/响应中的私密内容提交到仓库。
2. 用 Chrome、Edge 和现场设备验证 ASR 权限、系统默认输入设备、interim 字幕、手动文字合并及 TTS；若需要跨浏览器稳定语音识别，增加受控后端 ASR 服务。若需要真实蓝色 AI 波形，接可播放的 TTS 音频流，而非浏览器 SpeechSynthesis。
3. 对照 FacePhys 实际响应再扩展 server/facephys.ts、src/services/biometrics/types.ts 和 src/services/biometrics/apiProvider.ts；只展示实际返回、经质量检查的数据。不要自行生成“紧张/自信”等无依据标签。
4. 与企业端确定协议后替换 rooms.ts 演示适配器；正式多人系统需要后端会话持久化、鉴权、用户隔离、数据保留/删除策略与 HTTPS。
5. 若继续修改 UI，保持现有结构与橙色系一致，避免改动摄像头采集和已验证的面试状态机逻辑。

