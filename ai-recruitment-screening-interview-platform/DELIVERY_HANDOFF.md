# TTC 智能简历投递、初筛与 AI 初面：交付交接报告

更新日期：2026-11-14。本报告描述本目录中的源码快照，供下一位开发者及其 AI 助手接手。它不是生产上线验收书；本机演示功能与生产安全要求必须分开看待。

## 1. 项目目标与当前范围

TTC 原有企业面试官与候选人双人面试系统，包含实时提示、场次报告和候选人复盘。在此基础上增加完整招聘入口：企业发布岗位；候选人上传 PDF/DOCX 简历；后台解析和调用硅基流动上的 DeepSeek 做岗位相关初筛；HR 查看可追溯证据并人工决策；获邀候选人进入 AI 初面；完成后 HR 查看基于真实问答的分析。

设计原则是“AI 提供证据和追问，HR 决定”。简历表述笼统只能标记为证据不足并提出核验问题，不能据此断言 AI 代写、经历造假或候选人不诚信。没有证据的模型引文不能当成事实；初面未完成时也不能编造面试分析。

## 2. 已交付的功能

| 模块 | 当前行为 | 主要位置 |
|---|---|---|
| 候选人端 | 登录、查看岗位、投递简历、查看进度/邀请、申请更正和删除本人申请 | personal/recruitment.js、personal/*.html |
| 企业端 | 发布岗位、查看本企业申请和原件、查看 AI 初筛、记录内部审核意见、邀请或暂缓 | frontend/screening.js、frontend/screening.html |
| 简历处理 | 仅接收不超过 8 MB 的 PDF/DOCX；解析原文和结构化字段，异步持久化 | qiyeduan/backend/recruitment_resume.py、recruitment_api.py |
| AI 初筛 | 按岗位 JD、简历与候选人授权的职业链接生成结构化报告；核对模型引用；失败可重试 | resume_screening_prompt.py、resume_screening_service.py、recruitment_evidence.py |
| 正式 AI 初面 | 已获邀申请才能开始；服务端记录题目和回答；所有题目有效回答后才能完成 | formal_interview_api.py、recruitment_store.py、gerenduan/ |
| 面试分析 | 初面完成后异步调用模型，生成有回答原文引证的 HR 分析；失败可重试 | interview_analysis_service.py、recruitment_api.py |
| 原有双人面试 | 保留房间、实时提示、会话/场次报告和候选人复盘 | qiyeduan/backend/engine.py、ws.py、report.py、frontend/、personal/ |

本机演示模式通过服务端 RECRUITMENT_DEMO_MODE=1 显式开启，并且只接受 loopback 请求。开启后，企业端打开网址即可进入演示 HR 工作台；候选人输入任意非空测试账号和密码即可进入，密码不校验。正式部署应保持该变量为 0，使用正常账户体系。此模式是测试便利功能，绝非正式鉴权方案。

## 3. 运行架构与数据流

FastAPI 是统一入口，默认监听 127.0.0.1:8000：挂载 /classic/ 企业静态页、/personal/ 候选人静态页及构建后的 /ai-interview/。招聘相关路由在 recruitment_api.py；正式面试路由在 formal_interview_api.py。SQLite 和简历原件保存在后端的 .local-data/ 或 RECRUITMENT_DATA_DIR 指定目录，数据由 recruitment_store.py 管理。

正式 AI 初面的 React/Vite 界面和 Node 侧车在 gerenduan/。侧车默认监听本机 8787；若改用 8788，后端 INTERVIEW_SIDECAR_URL 与侧车 INTERVIEW_API_PORT 必须一致。后端代浏览器调用侧车，并验证申请归属、邀请状态与尝试 ID。硅基流动凭据只由服务端读取；初筛、面试后分析及正式初面的模型交互应始终留在服务端。

主要流程：

1. HR 发布包含职责和必备要求的岗位；候选人选择岗位并授权提交简历。
2. 后台解析简历，按用户授权处理职业作品链接，然后调用硅基流动兼容的聊天接口。默认模型由 SILICONFLOW_MODEL 指定，当前默认值为 deepseek-ai/DeepSeek-V4.1-Flash。
3. 初筛结果通过严格 JSON Schema；简历/JD 引文必须能在原文定位。PDF/DOCX 换行及空白差异会被容忍；无法定位的引文被剔除并加入限制说明。缺少足够岗位描述或有效证据时不给匹配分。
4. HR 查看“经历内容与待核实点”、匹配依据、限制和原始文件。结构化简历默认折叠，页面不再重复铺开整份解析原文。HR 审核意见仅记录企业内部核验与决策依据。
5. HR 邀请后，候选人开启正式 AI 初面。题目与回答绑定到申请；完成全部题目后才排队生成面试分析。HR 页面展示逐题证据与推理，原始问答可展开复核。

## 4. 近期故障与修复说明

此前有一份本机演示申请的初筛显示“未完成”：硅基流动模型已返回内容，但原文引文的逐字匹配过严，导致整份报告被丢弃。现已调整为容忍文档提取产生的空白差异，剔除无法定位的引文，而不是直接丢弃整份报告；没有可用匹配依据时不评分。该申请重试后初筛状态为 completed，并形成 6 条“经历内容与待核实点”。此数字只说明本机演示样本的测试结果，不代表对其他简历的固定输出。

企业详情页同时加入初筛失败重试和面试分析失败重试入口；处理中状态定时刷新。报告显示实际模型名。当前那份演示申请的正式初面仍为进行中，所以不存在可诚实展示的完整面试分析；完成后由后台任务生成。

## 5. 关键文件和接口

- qiyeduan/backend/main.py：FastAPI 装配、静态页面挂载与后台任务生命周期。
- qiyeduan/backend/recruitment_api.py：认证、岗位、申请、HR 复核、初筛重试、面试分析重试和异步 worker。
- qiyeduan/backend/recruitment_store.py：SQLite schema、租户范围查询、令牌及申请/报告/面试状态持久化。
- qiyeduan/backend/resume_screening_prompt.py：初筛输出约束、经历分析方向与不可臆断规则。
- qiyeduan/backend/resume_screening_service.py：硅基流动请求、Schema 校验、证据引用过滤与有界重试。
- qiyeduan/backend/interview_analysis_service.py：完成后的岗位+简历+问答分析及回答引文校验。
- qiyeduan/backend/formal_interview_api.py：本人正式面试尝试、出题转发、回答保存与完成判定。
- frontend/screening.js：HR 工作台、报告展示、人工意见及重试操作。
- personal/recruitment.js：候选人投递、申请列表与本机演示登录。
- gerenduan/server/index.ts：正式面试 Node 侧车；gerenduan/src/ 为候选人初面界面。

主要 HTTP 接口：公开岗位 GET /api/jobs；认证 POST /api/auth/register、POST /api/auth/login；候选人 POST /api/applications、GET /api/applications/my；HR GET /api/hr/applications、POST /api/hr/applications/{id}/review、POST /api/hr/applications/{id}/screening/retry、POST /api/hr/applications/{id}/interview-analysis/retry；正式初面 POST /api/applications/{id}/ai-interview/start、POST /api/applications/{id}/ai-interview/answers、POST /api/applications/{id}/ai-interview/complete。完整字段请以路由代码和测试为准。

## 6. 本地启动与验证

准备 Python 与 Node 依赖，然后在不同终端启动：

    cd gerenduan
    npm ci
    npm run build:formal
    npm run api:formal

    cd qiyeduan/backend
    python -m venv .venv
    .venv/Scripts/python -m pip install -r requirements.txt
    .venv/Scripts/python -m uvicorn main:app --host 127.0.0.1 --port 8000

Linux/macOS 将虚拟环境命令改成对应的 bin/python。将 qiyeduan/backend/.env.example 复制到本地 .env，再由维护者在本机或部署环境设置凭据；不要把真实值写回示例、源码或本报告。演示页面为 http://127.0.0.1:8000/classic/screening.html 和 http://127.0.0.1:8000/personal/account.html。若正式初面页面未挂载，先确认 npm run build:formal 已完成。

最近一次针对性验证：后端 20 项相关 unittest 通过；frontend/screening.js 与 personal/recruitment.js 的 node --check 通过；本机 8000 端口返回企业详情页面与演示模式接口，原失败申请初筛重跑后为 completed。没有把真实候选人回答伪造为“面试已完成”来测试后分析。完整测试可在后端运行 python -m unittest discover -s tests -v；Node 端测试见 gerenduan/package.json。

## 7. 已知边界与下一步方向

1. 先用真实完成的正式初面验证“全部回答入库 → 后台分析 → HR 页面展示/重试”整条链，再补一次浏览器级回归。当前进行中的演示申请不能充当已完成样本。
2. 上线前关闭演示模式，补齐旧双人面试端点的统一鉴权、TLS、限流、CORS 收紧和企业成员邀请/管理。现阶段不要把整站直接公开接收真实候选人资料。
3. 为模型返回格式变动、超时、引用丢弃与空证据增加运维可见性；保持“失败可人工处理/重试”，不要用假模型结果填补生产报告。
4. 考虑把初筛、正式面试分析与页面交互做成可观测状态机；确认重复请求、进程重启和并发 worker 下的幂等性。
5. 如需评估所谓“简历水分”，只讨论可核验的事实缺口、个人贡献、方法、成果口径和与 JD 的关系；不得把语言风格当作 AI 代写或诚信判断依据。

## 8. 给下一位开发者与 AI 助手

先读本报告、根 README、qiyeduan/backend/README.md，再沿“候选人 → 申请 → 初筛 → HR → 邀请 → 正式初面 → 面试分析”的现有状态与测试修改。优先补空白或故障点，不要重写已有流程。所有输出中的简历与回答引文都要可回到原文；无法核实时明确写限制。先在本机使用假模型或受控样本验证，再经明确安排调用付费真实模型。生产凭据与个人数据只从运行环境读取，不提交到 Git。
