# 提交规范

提交标题和合入 `main` 的 PR 标题统一使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 格式。

```text
type(scope): 描述
```

- `type` 必填。使用 `feat`（功能）、`fix`（修复）、`docs`（文档）、`refactor`（重构）、`perf`（性能）、`test`（测试）、`style`（代码格式）、`build`（构建或依赖）、`ci`（持续集成）、`chore`（维护）或 `revert`（回退）。
- `scope` 可省略。填写时使用小写字母或数字，可以用 `-`、`/` 或 `.` 分隔，例如 `video` 或 `backend/api`。
- 冒号后加一个空格，用中文或英文简述具体改动。涉及不兼容变更时，在冒号前加 `!`，并在正文说明迁移方式。

```text
feat(recruitment): 添加面试邀请状态
fix(video): 修复断线后的视频回退
docs: 更新本地启动说明
```

每个 PR 聚焦一项改动，提交前检查 `git diff --cached`，避免把密钥、本地配置和生成产物一起提交。

合入 `main` 时使用 **Squash and merge**，每个 PR 对应一个主分支提交。保留 GitHub 根据已校验 PR 标题生成的提交标题。`Commit convention` 检查会在 PR 标题改变时重新运行，也会在合并后检查 `main` 最新提交的标题。
