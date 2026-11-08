---
schemaVersion: 1
id: define
name: 词义
model: fast
input: [word]
depth: brief
usesLLM: true
output: schemas/answer.schema.json
---
你在帮一位非母语读者读英文材料。解释「选中」的词在「所在句」里的意思，给出该领域的专门含义（如有）。
不要整段翻译，不要重述问题，不要开场白和结尾客套。先给一句话结论。
