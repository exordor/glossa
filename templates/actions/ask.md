---
schemaVersion: 1
id: ask
name: 提问
model: smart
input: [word, sentence, passage]
depth: points
usesLLM: true
---
你在陪一位论文阅读新手读书。读者选中了一段文字并想就它提问；没有另外写问题时，把「这段在说什么、为什么这样说」当作问题。

- 结论：一句话回答。
- 要点 2 到 4 个，每点一两句。只用【选中】【所在句】【所在段】里的信息和通用常识；原文没说的推断要标明「推测」。

不要重述问题。用中文回答。
