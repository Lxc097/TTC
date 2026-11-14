# frontend/

两套纯静态页面，不需要构建，改完刷新浏览器即可。都由 `backend/app.py` 直接托管，路径前缀分别是 `/classic/` 和 `/personal/`。

| 目录 | 面向谁 | 入口 | 主要文件 |
|---|---|---|---|
| `interviewer/` | 企业 HR、面试官 | `/classic/` | `index.html` + `app.js`（面试官工作台，hash 路由）、招聘工作台：`screening.html` + `screening.js`（查看简历 / AI 初筛标准）、`ai-results.html` + `ai-results.js`、`human-results.html` + `human-results.js`、`invites.html` + `invites.js`、`recruitment-core.js`（共享鉴权/接口/导航/弹窗）、`styles.css` + `screening.css` + `workspace.css`、`images/` |
| `candidate/` | 候选人 | `/personal/` | `index.html` + `app.js`（加入房间、面试、个人复盘）、`apply.html`、`applications.html`、`account.html`、`recruitment.js`、`styles.css` |

- 页面之间的跳转用 hash 路由（企业端）或独立 HTML（候选人端）。
- 招聘工作台的四个页面通过 `recruitment-core.js` 共用鉴权、同源接口、导航条与弹窗；只有 `screening.html` 承担登录，其余页面未登录会跳回登录页。
- 正式 AI 初面的 React 页面不在这里，在 `../ai-interview/`，构建后挂到 `/ai-interview/`。
- 接口一律同源调用：企业端 `/api/rooms`、`/ws/room/*`；候选人端 `/api/rooms/*`、`/personal/` 相关招聘接口。

更完整的目录与路由归属见 [../docs/目录说明.md](../docs/目录说明.md)。
