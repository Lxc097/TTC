# 简历批量导入与智能识别

此目录是现有 TTC 招聘后端的简历增量功能。没有复制整个旧项目，也没有包含密钥或候选人真实数据。

## 流程

1. 企业初筛页一次选择岗位，把多个 PDF 或 ZIP 拖进上传区。每个 ZIP 代表一名候选人，包含一份主 PDF 简历和最多 24 份 PDF/PNG/JPG 佐证材料。
2. `api.py` 的 `POST /api/hr/resumes/batch` 校验 HR 的企业权限、授权确认、文件数量与大小，然后把简历加入原有 SQLite 申请及初筛队列。ZIP 在内存中读取，不按压缩包路径写文件；佐证材料保存在 `application_attachments`，并以申请 ID 关联。
3. 原有 `candidate/recruitment_api.py` 先提取 PDF 文字。扫描版提取不足时，`ocr.py` 用服务端 `SILICONFLOW_API_KEY` 调用硅基流动 `deepseek-ai/DeepSeek-OCR`，识别文字后继续使用原有 DeepSeek 初筛。初筛结果额外提供只摘录简历原文的候选人信息条。
4. 企业详情页显示信息条、初筛报告和关联佐证材料。佐证材料只能由同企业 HR 读取；它们不自动构成经历真实性证明。解析失败可调用 `POST /api/hr/applications/{id}/resume/retry`；已解析但初筛失败继续使用原有 `/screening/retry`。

## 限制与配置

- 单份 PDF 最多 8 MB；ZIP 最多 32 MB，最多 40 个成员，解压总量最多 64 MB。单批最多 30 个文件、96 MB 上传内容，解压后写入总量最多 128 MB。
- OCR 兜底只处理最多 5 MB、8 页的扫描版 PDF；超过限制会保留失败原因供 HR 更换文件或人工处理。
- 初筛默认超时为 90 秒，可用服务端 `SCREENING_TIMEOUT` 覆盖，上限 120 秒。模型 HTTP 状态与超时分类可见，但上游正文、简历原文和密钥不会写入错误信息。
- 密钥只放服务端环境变量或被 Git 忽略的 `backend/.env`。此目录没有上传简历、数据库、佐证原件或密钥。

## 接入位置

`backend/app.py` 挂载本目录路由；`backend/candidate/recruitment_store.py` 创建附件表并提供企业范围内的关联查询；`backend/candidate/recruitment_api.py` 接 OCR 兜底；`frontend/interviewer/screening.js` 与 `screening.css` 提供拖放、查看和重试界面。现有候选人投递、岗位、面试阶段与真人面试逻辑继续留在原模块。

在 `backend` 目录运行相关检查：

```powershell
python -m unittest tests.test_jianli_ocr tests.test_recruitment_api tests.test_resume_screening_service -q
```
