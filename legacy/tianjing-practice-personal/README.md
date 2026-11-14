# 天镜 Practice · AI 模拟面试个人端

React + TypeScript + Vite 的可运行个人端 Demo。支持自由岗位输入、简历辅助出题、DeepSeek 动态追问（未配置时本地回退）、设备检测、摄像头画中画、可编辑语音转写、逐题报告和本地历史记录；不包含企业端通话服务。

## 本地启动

需要 Node.js 和 npm。在本目录运行：

    npm install
    npm run dev

用本机浏览器打开终端显示的 Local 地址（通常为 http://127.0.0.1:5173/；端口占用时会自动递增）。开发命令同时启动 Vite 页面和本地 API 代理，默认仅监听本机。检查命令：

    npm run typecheck
    npx tsc -p tsconfig.server.json --noEmit
    npm run lint
    npm run build

硅基流动密钥只由本地 Node 代理读取，不进入前端。Windows PowerShell 中可用以下方式在当前终端安全输入，再启动服务或运行一次付费冒烟测试（不会写入文件）：

    $secure = Read-Host 'SiliconFlow API Key' -AsSecureString
    $env:SILICONFLOW_API_KEY = [System.Net.NetworkCredential]::new('', $secure).Password
    npm run smoke:siliconflow
    npm run dev

冒烟脚本只发一条短消息，并输出回复、prompt_tokens 和 completion_tokens；正式面试不限于一次调用，会按所选难度生成题目并追问。缺少密钥时冒烟脚本直接退出，网站回退本地题库。SILICONFLOW_BASE_URL 默认保留 /v1，SILICONFLOW_MODEL 默认是 deepseek-ai/DeepSeek-V4.1-Flash；要更换模型，修改运行环境中的 SILICONFLOW_MODEL，并先用平台模型列表确认该 ID 可用。可选的非密钥配置见 .env.example。更换 INTERVIEW_API_PORT 时同步修改 vite.config.ts 的代理目标。

FacePhys 凭据也只由本地 Node 代理读取。不要写入前端、.env 示例、日志或提交记录；在启动服务的同一个 PowerShell 终端中安全输入：

    $faceId = Read-Host 'FacePhys Key ID' -AsSecureString
    $env:FACEPHYS_KEY_ID = [System.Net.NetworkCredential]::new('', $faceId).Password
    $faceSecret = Read-Host 'FacePhys Secret' -AsSecureString
    $env:FACEPHYS_SECRET_KEY = [System.Net.NetworkCredential]::new('', $faceSecret).Password
    npm run dev

API 状态可通过 /api/biometrics/status 检查；configured:false 表示服务端未读到凭据。明确授权且摄像头开启后，FacePhys 以约 30 秒视频片段连续采集，上一段处理完成后才开始下一段；结果存在延迟，并非逐帧实时检测。结束时不足 15 秒的片段不会伪造结果。

## 摄像头与语音验证

首页 → 开始模拟面试 → 自由输入目标岗位、可选填写面试重点和上传 PDF/DOCX/TXT 简历 → 选择类型、难度、时长 → 检查设备。简历原文件不上传，提取文本可用于 DeepSeek 出题，且不会写进历史记录。摄像头画面来自实时 MediaStream；可选择设备、关闭摄像头，或明确选择纯文字面试。请在 localhost 或 HTTPS 下测试权限。

设备页可选择麦克风并查看输入电平。面试问题直接显示在主舞台，右侧回答框可修改转写；人工编辑后，新的确认语音片段暂存，点击“合并到回答”才写入草稿。正式历史只保存 final 片段和用户确认的最终文本，不保存每次 interim 字幕。Web Speech 可能使用系统默认输入设备，所选麦克风用于音量采集。朗读或识别失败时仍可打字作答。自动完成默认关闭，开启后需满足回答时长与静音条件。

浏览器 SpeechSynthesis 没有提供可供 Web Audio 读取的播放音频流，因此使用浏览器朗读时面试官波形明确标注“浏览器朗读音量不可读取”，不会显示伪造的波形。麦克风波形来自真实 MediaStream 的 AnalyserNode。后续有可播放 TTS 音频 URL 时，useInterviewAudio.speak(text, { audioUrl }) 已支持真实播放音频驱动的蓝色波形与头像幅度联动；目前尚无 TTS 音频服务。

## 主要结构

    src/pages/                       首页、配置、设备、面试、报告、历史、房间入口
    src/components/interview/room/   AI 舞台、题目、转写、设备状态、控制栏、退出弹窗
    src/components/camera/           CameraManager、真实预览、画中画
    src/hooks/                       音频采集、ASR/TTS、面试阶段 reducer
    src/data/                        五岗位题库和难度策略
    src/services/interviewClient.ts  DeepSeek 出题/追问与本地降级客户端
    src/services/biometrics/         FacePhys 分段录制适配器与数据类型
    src/utils/resume.ts              PDF/DOCX/TXT 简历文字本地提取
    src/services/rooms.ts            企业房间服务演示适配器
    src/utils/                       自动完成条件、规则报告、本地存储
    server/index.ts                  面试会话、FacePhys 同源代理与追问次数校验
    server/questionPlan.ts           DeepSeek 岗位及简历定制出题
    server/facephys.ts               FacePhys 签名、预签名上传及 V3 视频分析
    server/siliconflow.ts            OpenAI 兼容调用、配置与错误映射
    scripts/siliconflow-smoke.ts     单次付费冒烟测试

## 数据与后续联调

文本评分先区分空白、无效、跑题和有效回答，再根据真实回答内容、题目主题词与表达结构生成建议。原始简历与视频不保存到 localStorage。正式面试不产生模拟心率或情绪数据，且在面试期间不显示生理分析。未授权时不会向 FacePhys 发送视频；历史 Mock 记录可打开，但模拟数值不进入正式图表。

FacePhys 适配层依据官方 V3 流程实现预签名、对象存储上传和分析调用。只映射实际返回的心率、信号质量及可用扩展指标；没有的表情字段保持空值。报告先显示纯内容分析，FacePhys 结果延迟返回时自动更新为完成或失败。生理信号只作独立观察，不参与文本评分。后续调整字段请修改 server/facephys.ts、src/services/biometrics/apiProvider.ts 与 types.ts；凭据仅留在服务端环境变量。

与企业端联调时，需要确定房间号和昵称格式、加入/离开/状态接口、服务端确认的房间状态、鉴权及错误码、面试官进入事件、实时订阅、音视频信令、ICE/TURN 和断线重连。现有 joinInterviewRoom()、getInterviewRoomStatus()、leaveInterviewRoom() 为本地演示流程，demo_waiting 不代表真实连接成功。
