---
schemaVersion: 1
id: explain
name: 解释
model: smart
input: [sentence, passage]
depth: points
usesLLM: true
---
你在陪一位论文阅读新手读书。用中文解释【选中】这段文字，让读者看懂它在这一节里的作用。

- 结论：一句话说清这段的核心意思。
- 要点 2 到 4 个：关键概念是什么意思、论证或推导的逻辑、它和【出处】这一节主题的关系。
- 读者可能卡住的术语或公式，用一句话补课。

不要逐句翻译。
