# TTC V2.0 生产升级

旧入口 deploy/setup.sh 已停用：它曾强制重置 Git 并重写 nginx 与 systemd。不要再执行旧的 curl setup.sh | bash。当前 V2 工作树尚未上传或部署；先确认完整 V2 代码已进入 origin/main，再从服务器本地运行 deploy/upgrade-v2.sh。

## 适用前提

- Ubuntu 上已有 /opt/ttc Git 工作树，位于 main 分支；/opt/ttc/backend/.env、ttc-backend.service、/etc/nginx/sites-available/woaiyrb.com 均存在。
- Node.js 22.12+、npm、Python 3、Git、nginx、curl 和 systemd 可用。安排维护窗口：备份、拉取、安装依赖和构建期间会停止 Python 后端；脚本失败时会尝试重新启动。
- 核对生产 .env 的现有 SiliconFlow/UAPI 配置。招聘模型设为 RECRUITMENT_AI_MODEL=deepseek-ai/DeepSeek-V4.1-Flash；初始并发可设 AI_MAX_CONCURRENCY=3、SEARCH_MAX_CONCURRENCY=3。不要将真实密钥写入 Git 或部署文档。若使用自定义 RECRUITMENT_DATA_DIR，确认目录可读。

## 执行

先核对目标版本和工作树，再以 root 运行：

    sudo -i
    git -C /opt/ttc status --short
    git -C /opt/ttc fetch origin main
    git -C /opt/ttc log -1 --oneline origin/main
    git -C /opt/ttc show origin/main:deploy/upgrade-v2.sh > /root/ttc-upgrade-v2.sh
    bash /root/ttc-upgrade-v2.sh

脚本只允许 git merge --ff-only origin/main；发现受跟踪文件有本地改动、分支不符或缺少现有配置就停止。它不会执行 git reset、git clean、删除生产数据或重建数据库。

升级前会创建权限受限的 /opt/ttc-backups/v2-时间戳-*，保存生产 backend/.env、原 nginx 站点配置、后端单元内容、升级前后 commit，以及工作树内全部 .local-data。若 .env 指向自定义 RECRUITMENT_DATA_DIR，也会备份该目录。复制期间停止 SQLite 写入者，备份包括数据库、-wal、-shm、简历与佐证附件。已有的 Node 单元和 V2 nginx 片段也会另存原件。脚本不会删除旧备份；请按现有策略做异地备份。回退时先检查日志和 before-commit.txt，不能直接覆盖运行中的数据库。

## 路由与进程

脚本保留站点根路径、/personal/、/api/、/ws/、TLS 证书和 ttc-backend.service，只在原站点的 server 块追加受管 nginx 片段，通过 nginx -t 后 reload：

| 路径 | 目标 |
|---|---|
| /classic/ | FastAPI 托管的企业端页面，含 V2 简历工作台 |
| /ai-interview/ | npm run build:formal 生成的正式 AI 初面页面，由 FastAPI 托管 |
| /api/interview/ | 先到 FastAPI 完成身份和申请关联校验，再由它调用只监听 127.0.0.1:8787 的 Node 侧车 |
| /api/hr/resumes/batch | nginx 上传上限 100 MB，后端仍保留自己的限制 |
| /api/hr/.../progress/events、/api/hr/architect/.../messages/stream | 关闭 nginx 响应缓冲并延长读取超时，实时 SSE |

新增的 ttc-interview-api.service 读取原 backend/.env；脚本不改写既有后端单元。INTERVIEW_API_PORT 与 INTERVIEW_SIDECAR_URL 如改为非默认端口，先同步调整部署脚本的 8787 健康检查。

## 升级后核对

    systemctl status ttc-backend ttc-interview-api
    journalctl -u ttc-backend -n 100 --no-pager
    journalctl -u ttc-interview-api -n 100 --no-pager
    nginx -t
    curl -fsS http://127.0.0.1:8000/healthz
    curl -fsS http://127.0.0.1:8787/api/interview/status

浏览器核对 https://woaiyrb.com/classic/screening.html 和 https://woaiyrb.com/ai-interview/，再用授权测试账号检查招聘顾问流式答复、三条独立声明并行进度，以及原有候选人记录。SSH 当前未授权；这份脚本尚未在云服务器执行。