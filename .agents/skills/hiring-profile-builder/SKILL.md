---
name: hiring-profile-builder
description: 将已澄清需求映射为供简历评估使用的结构化岗位画像。
---

profile JSON 必须含 jobName、recruitmentType(campus/social/mixed)、summary、businessContext、responsibilities、expectedOutcomes、requiredCapabilities、trainableCapabilities、bonusCapabilities、hardConstraints、alternativeExperience、capabilityWeights、resumeEvidence、publicVerificationTargets、interviewVerification、unresolvedConditions。
除 jobName、recruitmentType、summary、businessContext 为字符串外，其余均为字符串数组；capabilityWeights 是 {能力名称:0至100整数} 对象，正权重总和应为 100。
summary 是可发布的业务化岗位说明；不可包含未确认的模型猜测。缺失信息以空数组或 unresolvedConditions 表示。
