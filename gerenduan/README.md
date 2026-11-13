# 天镜 Practice · AI 模拟面试个人端

React + TypeScript + Vite 的可运行黑客松 Demo。个人端包含简历上传、目标岗位自述、DeepSeek 个性化出题与动态追问、设备检测、沉浸式面试间、文字与浏览器语音作答、规则报告和本地历史记录；不包含企业端通话服务。

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

API 状态可通过 /api/biometrics/status 检查；configured:false 表示本地服务还没有读到凭据。不要把密钥放在 VITE_ 开头的变量中。FacePhys 云端 V3 处理 15–120 秒视频，本 Demo 在明确授权并主动选择真实模式后只录制并上传一次约 30 秒片段；它是分段分析，不是逐帧实时检测，也不会自动循环产生付费请求。

## 摄像头与语音验证

首页 → 开始模拟面试 → 选择岗位、输入具体岗位描述、可选上传 PDF/DOCX/TXT 简历 → 选择类型、难度、时长 → 检查设备。简历最多 8 MB，本地提取最多 8,000 字；原文件不上传，提取文本会发给 DeepSeek 生成题目，但不会写进历史记录。扫描版 PDF 需要先 OCR。点击“开启摄像头”，在浏览器权限提示中允许访问；画面必须是设备当前实时采集。授权后在“使用的摄像头”列表选择设备。接线后未显示时先刷新设备列表，再检查系统相机权限和设备占用。关闭摄像头后视频轨道会停止；面试页小窗放大、缩小、镜像只改变显示，不重新请求权限，也不降低原始采集分辨率。请在 localhost、127.0.0.1 或 HTTPS 下测试；无设备或拒绝权限可继续文字面试。

在设备页点击“检测麦克风”可看输入电平。浏览器语音识别使用系统默认输入设备；如果电平不动，请检查系统麦克风。进入面试后，**文字回答框默认展开**，无需语音也可直接输入并点击“完成回答”；朗读未启动或转写失败不会阻止提交。题目始终显示在右侧，舞台左下角可手动“重新朗读”，面试页设备卡还会显示真实麦克风输入电平。浏览器朗读声音仍取决于系统输出设备、音量与浏览器语音能力，Web Speech 转写也可能依赖浏览器服务；无声或无有效转写时请直接用文字回答。自动完成默认关闭；打开后，至少说话 12 秒且静音 8 秒并有有效转写才会出现 2 秒倒计时。继续说话会取消倒计时，手动取消后本轮需再次说话或重新开启设置才会重启。

浏览器 SpeechSynthesis 没有提供可供 Web Audio 读取的播放音频流，因此使用浏览器朗读时面试官波形明确标注“浏览器朗读音量不可读取”，不会显示伪造的波形。麦克风波形来自真实 MediaStream 的 AnalyserNode。后续有可播放 TTS 音频 URL 时，useInterviewAudio.speak(text, { audioUrl }) 已支持真实播放音频驱动的蓝色波形与头像幅度联动；目前尚无 TTS 音频服务。

## 主要结构

    src/pages/                       首页、配置、设备、面试、报告、历史、房间入口
    src/components/interview/room/   AI 舞台、题目、转写、设备状态、控制栏、退出弹窗
    src/components/camera/           CameraManager、真实预览、画中画
    src/components/analytics/        生理数据面板
    src/hooks/                       音频采集、ASR/TTS、面试阶段 reducer
    src/data/                        五岗位题库和难度策略
    src/services/interviewClient.ts  DeepSeek 出题/追问与本地降级客户端
    src/services/biometrics/         Mock 与 FacePhys 分段录制适配器
    src/utils/resume.ts              PDF/DOCX/TXT 简历文字本地提取
    src/services/rooms.ts            企业房间服务演示适配器
    src/utils/                       自动完成条件、规则报告、本地存储
    server/index.ts                  面试会话、FacePhys 同源代理与追问次数校验
    server/questionPlan.ts           DeepSeek 岗位及简历定制出题
    server/facephys.ts               FacePhys 签名、预签名上传及 V3 视频分析
    server/siliconflow.ts            OpenAI 兼容调用、配置与错误映射
    scripts/siliconflow-smoke.ts     单次付费冒烟测试

## 数据与后续联调

文本评分仅由实际回答长度、题目主题词与结构线索计算；AI 生成题目的主题词也保存在报告中供解释。原始简历与视频不保存到 localStorage。生理信号 Mock 与摄像头画面无关；面板和报告始终标记“演示数据”，且不参与回答能力评分。未同意画面分析时不会向 FacePhys 发送视频。

FacePhys 适配层依据官方 V3 SDK 实现视频预签名、对象存储上传和分析调用。当前仅映射官方响应中的心率、信号质量、表面情绪和呼吸频率；没有的字段保持空值，不补造结果。后续调整字段或节奏时，修改 server/facephys.ts、src/services/biometrics/apiProvider.ts、types.ts 和 BiometricsPanel.tsx。私密 API 凭据始终留在服务端代理，不进入浏览器。

与企业端联调时，需要确定房间号和昵称格式、加入/离开/状态接口、服务端确认的房间状态、鉴权及错误码、面试官进入事件、实时订阅、音视频信令、ICE/TURN 和断线重连。现有 joinInterviewRoom()、getInterviewRoomStatus()、leaveInterviewRoom() 为本地演示流程，demo_waiting 不代表真实连接成功。
