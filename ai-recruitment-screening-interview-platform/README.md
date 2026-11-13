# TTC · 企业招聘与面试双端

> 候选人投递简历，企业 HR 审核内部 AI 初筛并决定是否邀请初面；现有面试功能继续提供实时追问与候选人复盘。

## 现有面试功能

| | 企业端（面试官） | 个人端（真实面试候选人） |
|---|---|---|
| 入口 | `/classic/`（本地）或站点根路径（部署后） | `/personal/` |
| 输出 | 实时追问提示与面试质量报告 | 本场纪要、本人发言摘录与表达建议 |
| 不输出 | 面试报告中的候选人排名或自动淘汰建议 | 录用判断、表现分、面试官内部提示 |

`gerenduan/` 原为模拟面试原型，正式 AI 初面现在复用其中的语音问答页面与动态追问逻辑；原独立房间面试仍在 `personal/` 与 `classic/`。

## 目录

```
TTC/
├── qiyeduan/          企业端（面试官侧）
│   ├── backend/       FastAPI 后端、招聘申请持久化与面试服务
│   └── docs/          双边方案与网页端功能梳理
├── frontend/          企业端网页（HR 初筛与面试官）
├── personal/          候选人投递、申请进度与真实面试页面
├── gerenduan/         既有面试引擎；正式 AI 初面构建后挂载到 /ai-interview/
├── README.md
└── .gitignore
```

## 快速开始

```bash
cd qiyeduan/backend
pip install -r requirements.txt
set VISION_PROVIDER=mock
uvicorn main:app --reload --port 8000
```

打开 <http://127.0.0.1:8000/classic/> 是企业端，创建房间后复制候选人链接；
候选人在 <http://127.0.0.1:8000/personal/> 输入房间号，或直接打开邀请链接。
<http://127.0.0.1:8000/> 仍是后端自测台。原 /personal/ 与 /classic/ 双人房间同源；正式 AI 初面复用 gerenduan 面试引擎并挂载到 /ai-interview/。
候选人报告只依据本场真实转写，提供可追溯的表达建议，不展示面试官内部提示或候选人分数。
本机密钥放在 `qiyeduan/backend/.env`（已被 Git 忽略），默认 `VISION_PROVIDER=mock` 可避免调试时触发付费画面分析。

> 当前仍是本地联调版本：旧企业端场次列表和未绑定招聘申请的按会话 ID 报告接口尚无完整角色鉴权。招聘申请 API 已按本人和企业隔离；整站上线前仍需统一加固旧面试端点、TLS、CORS、限流与企业开户流程。
细节见 [qiyeduan/backend/README.md](qiyeduan/backend/README.md)。

## 简历投递与初筛

候选人在 <http://127.0.0.1:8000/personal/apply.html> 注册或登录，选择企业发布的岗位并上传 PDF/DOCX；在 <http://127.0.0.1:8000/personal/applications.html> 查看申请进度和邀请。企业 HR 在 <http://127.0.0.1:8000/classic/screening.html> 注册或登录，创建岗位、查看内部初筛报告并人工决定是否邀请 AI 初面。正式 AI 初面复用已有面试引擎；原 /personal/ 与 /classic/ 双人房间流程仍独立可用。

首次创建企业 HR 账号需服务端配置 HR_REGISTRATION_CODE 并输入开通码；该码只能创建新企业，不能加入已有企业。增加同企业 HR 账号仍需后续管理员邀请流程。招聘初筛从服务端读取 SILICONFLOW_API_KEY，默认使用硅基流动兼容地址 https://api.siliconflow.cn/v1 和模型 deepseek-ai/DeepSeek-V4.1-Flash；可通过 SILICONFLOW_BASE_URL、SILICONFLOW_MODEL、SCREENING_TIMEOUT 覆盖。密钥只放在后端环境变量或已忽略的 qiyeduan/backend/.env 中。未配置密钥或模型失败时，申请进入人工审核，报告不会伪装成真实 AI 结果。

申请、结构化报告、令牌哈希和简历原件持久化到 SQLite 与服务端目录，默认 qiyeduan/backend/.local-data/。可用 RECRUITMENT_DATA_DIR 指定存放位置，RECRUITMENT_RETENTION_DAYS 设置定期保留天数；候选人也可删除自己的申请，或向本人申请提交更正说明供对应 HR 查看。只有候选人授权时才尝试核验其主动提供的职业链接，不做跨平台身份猜测。候选人 API 不返回内部匹配分、核验结论或 HR 意见。

离线回归测试在 qiyeduan/backend 执行：先安装 requirements-test.txt，再运行 python -m unittest discover -s tests -v。测试使用明确标记的假模型结果，不会调用真实密钥。实际调用需要有效的硅基流动凭据和模型额度。详细接口和限制见 [后端说明](qiyeduan/backend/README.md)。

## 正式 AI 初面

启动前先在 TTC/gerenduan 执行 npm ci、npm run build:formal，随后保持 npm run api:formal 运行。它使用后端 .env 中的硅基流动配置，并默认只在本机 127.0.0.1:8787 提供出题、追问与回答总结。另开终端在 TTC/qiyeduan/backend 安装 requirements.txt，启动 python -m uvicorn main:app --host 127.0.0.1 --port 8000。须先构建网页，FastAPI 才会挂载 /ai-interview/。若 8787 被占用，在后端 .env 同时设置 INTERVIEW_API_PORT 和 INTERVIEW_SIDECAR_URL，例如 8788 与 http://127.0.0.1:8788，确保两个进程使用同一端口。

正式初面只接受已获邀请的本人申请；后端根据已存的岗位 JD 和简历创建一次正式尝试，保存题目、回答与完成状态。硅基流动不可用或仅返回本地题库时，正式初面会保持未开始并提示稍后重试，不把演示题库冒充真实初面。该流程的浏览器请求均经 FastAPI 鉴权，简历内部报告不会透传给候选人。更多接口与启动细节见 [后端说明](qiyeduan/backend/README.md)。

需要主动验证真实付费接口时，可在后端目录运行 python tools/smoke_recruitment_live.py（合成简历的真实初筛与旧双人房间）或 python tools/smoke_formal_interview.py（需先启动 Node 侧车，验证真实出题与回答总结）。第二个脚本默认探测 8788；若侧车使用 8787，请在运行前将 INTERVIEW_SIDECAR_URL 设为 http://127.0.0.1:8787。这两个脚本不在自动测试中运行。

## 三条不能破的规则

1. 不做情绪标签，只估计认知负荷的相对变化。
2. 生理 ∧ 行为双确认才出提示，单一信号一律静默。
3. 不让 AI 自动作招聘决定；岗位匹配指标仅在授权 HR 的内部初筛报告中出现。

## 许可证

待定
