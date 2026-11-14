# TTC · 企业招聘与面试双端

> 候选人投递简历，企业 HR 审核内部 AI 初筛并决定是否邀请初面；面试功能提供实时追问与候选人复盘。

## 功能地图

仓库按**功能**组织，而不是按「前后端各一堆」。每个功能都能在下面找到对应的前端页面、后端目录和访问入口。

| 功能 | 谁在用 | 前端 | 后端 | 入口 |
|---|---|---|---|---|
| 双人面试间：实时信号、追问提示、面试纪要 | 面试官 + 候选人 | `frontend/interviewer/`、`frontend/candidate/` | `backend/interviewer/` + `backend/shared/` | `/classic/`、`/personal/`、`/ws/room/{code}` |
| 面试报告与候选人个人复盘 | 面试官、候选人 | `frontend/interviewer/`、`frontend/candidate/` | `backend/interviewer/report.py` | 面试结束后的报告页 |
| 简历投递、申请进度与 HR 初筛 | 候选人、企业 HR | `frontend/candidate/`（apply / applications / account）、`frontend/interviewer/screening.html` | `backend/candidate/`（recruitment_*、resume_screening_*） | `/personal/apply.html`、`/classic/screening.html` |
| 招聘阶段推进：AI 初面邀请、真人面试安排与结论、邀请记录 | 企业 HR、候选人 | `frontend/interviewer/`：`screening.*`（查看简历 / AI 初筛标准）、`ai-results.*`、`human-results.*`、`invites.*`、`recruitment-core.js`；候选人阶段页在后续 PR 接入 | `backend/candidate/pipeline.py`、`recruitment_store.py`、`recruitment_api.py` | `/classic/screening.html`、`/classic/ai-results.html`、`/classic/human-results.html`、`/classic/invites.html`、`/api/hr/*`、`/api/applications/*` |
| 正式 AI 初面（出题、追问、回答总结） | 获邀候选人 | `ai-interview/`（React 页面） | `backend/candidate/formal_interview_api.py` + `ai-interview/server/`（Node 侧车） | `/ai-interview/` |
| 账号与权限隔离 | 候选人、HR | 上述页面 | `backend/candidate/recruitment_api.py` | `/api/auth/*`、`/api/candidate/*`、`/api/hr/*` |
| 公共基础：配置、信号引擎、模型与视觉适配 | 以上全部 | — | `backend/shared/`、`backend/app.py` | — |

## 目录

```
TTC/
├── frontend/
│   ├── interviewer/     企业端页面：面试官工作台 + HR 初筛台        → /classic/
│   └── candidate/       候选人页面：投递、申请、面试、复盘          → /personal/
├── backend/             FastAPI 服务，按功能分三个目录
│   ├── app.py           服务入口：挂载页面、/api/config、自测页
│   ├── interviewer/     面试间功能：房间、WebSocket、信号、报告
│   ├── candidate/       招聘功能：账号、投递、初筛、邀请、正式 AI 初面闸门
│   ├── shared/          公共基础：配置、信号引擎、内存存储、LLM/ASR/视觉
│   ├── static/          后端自测页（不加载前端也能验证接口）
│   ├── tests/           回归测试
│   └── tools/           真实接口验证脚本（探针、连通性、端到端）
├── ai-interview/        正式 AI 初面：React 页面 + Node 侧车         → /ai-interview/
├── deploy/              服务器部署：systemd、nginx、初始化脚本
├── docs/                方案、接入指南、验收文档、《目录说明》
├── legacy/              旧版整仓与历史演示副本（仅归档，不参与运行）
├── README.md
└── .gitignore
```

**每个目录具体做什么、改某个功能该去哪个文件夹，见 [docs/目录说明.md](docs/目录说明.md)。**

## 快速开始

```bash
cd backend
pip install -r requirements.txt
set VISION_PROVIDER=mock
uvicorn app:app --reload --port 8000
```

- 企业端：<http://127.0.0.1:8000/classic/>
- 候选人端：<http://127.0.0.1:8000/personal/>
- 后端自测：<http://127.0.0.1:8000/>
- 正式 AI 初面：先在 `ai-interview/` 执行 `npm ci && npm run build:formal`，再另开终端 `npm run api:formal`，然后访问 `/ai-interview/`

本机密钥放在 `backend/.env`（已被 Git 忽略）；默认 `VISION_PROVIDER=mock`，不产生任何付费调用。

> 当前仍是本地联调版本：旧企业端场次列表和未绑定招聘申请的按会话 ID 报告接口尚无完整角色鉴权。招聘申请 API 已按本人和企业隔离；整站上线前仍需统一加固旧面试端点、TLS、CORS、限流与企业开户流程。细节见 [backend/README.md](backend/README.md)。

## 简历投递与初筛

候选人在 <http://127.0.0.1:8000/personal/apply.html> 注册或登录，选择企业发布的岗位并上传 PDF/DOCX；在 <http://127.0.0.1:8000/personal/applications.html> 查看申请进度和邀请。企业 HR 在 <http://127.0.0.1:8000/classic/screening.html> 注册或登录，创建岗位、录入 PDF 简历、查看内部初筛报告并人工决定是否邀请 AI 初面。

首次创建企业 HR 账号需服务端配置 HR_REGISTRATION_CODE 并输入开通码；该码只能创建新企业，不能加入已有企业。招聘初筛从服务端读取 SILICONFLOW_API_KEY，默认使用硅基流动兼容地址 https://api.siliconflow.cn/v1 和模型 deepseek-ai/DeepSeek-V4.1-Flash；可通过 SILICONFLOW_BASE_URL、SILICONFLOW_MODEL、SCREENING_TIMEOUT 覆盖。未配置密钥或模型失败时，申请进入人工审核，报告不会伪装成真实 AI 结果。

申请、结构化报告、令牌哈希和简历原件持久化到 SQLite 与服务端目录，默认 `backend/.local-data/`。可用 RECRUITMENT_DATA_DIR 指定存放位置，RECRUITMENT_RETENTION_DAYS 设置保留天数。

## 正式 AI 初面

启动前先在 `ai-interview/` 执行 `npm ci`、`npm run build:formal`，随后保持 `npm run api:formal` 运行；侧车默认只监听本机 8787，后端代浏览器调用并校验申请归属。另开终端在 `backend/` 启动 `python -m uvicorn app:app --host 127.0.0.1 --port 8000`。须先构建网页，FastAPI 才会挂载 `/ai-interview/`。若 8787 被占用，在后端 `.env` 同时设置 INTERVIEW_API_PORT 和 INTERVIEW_SIDECAR_URL。

正式初面只接受已获邀请的本人申请；硅基流动不可用或仅返回本地题库时，正式初面保持未开始并提示稍后重试，不把演示题库冒充真实初面。

## 三条不能破的规则

1. 不做情绪标签，只估计认知负荷的相对变化。
2. 生理 ∧ 行为双确认才出提示，单一信号一律静默。
3. 不让 AI 自动作招聘决定；岗位匹配指标仅在授权 HR 的内部初筛报告中出现。

## 许可证

待定
