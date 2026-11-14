# TTC · 耳语 / 彩排

> 同一份心跳，面试官听到的是「该往哪问」，候选人听到的是「该往哪改」——我们从不说这个人好不好。

## 这是什么

| | 耳语（面试官侧） | 彩排（候选人侧） |
|---|---|---|
| AI 角色 | 静音旁观，只递追问建议 | 出声提问，当陪练 |
| 输出 | 追问点 + 面试质量报告 | 表达改进建议 |
| 不输出 | 候选人评分、排名、淘汰建议 | 表现分 |

## 目录

```
TTC/
├── qiyeduan/          企业端（面试官侧）
│   ├── backend/       FastAPI 后端，已跑通全链路
│   └── docs/          双边方案与网页端功能梳理
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

打开 <http://127.0.0.1:8000> 是自测台，不用等前端就能走完整条链路。
细节见 [qiyeduan/backend/README.md](qiyeduan/backend/README.md)。

## 三条不能破的规则

1. 不做情绪标签，只估计认知负荷的相对变化。
2. 生理 ∧ 行为双确认才出提示，单一信号一律静默。
3. 不产生任何自动决策，也不出候选人评分。

## 许可证

待定
