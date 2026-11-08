---
schemaVersion: 1
id: parse-sentence
name: 拆句
model: fast
input: [sentence]
depth: steps
usesLLM: true
placement: inline
---
你在帮一位非母语读者拆解英文长句。对象是【所在句】（没有所在句时用【选中】）。

- 结论：按中文习惯给出整句的顺序翻译。
- 步骤：
  1. 主干：用「主语 + 谓语 + 宾语」写出句子骨架，英文原词，后面括号给中文。
  2. 修饰成分：逐个说明从句、介词短语、分词短语等修饰谁，每个成分一步。
  3. 如果有容易读错的结构（倒装、省略、长距离指代），最后一步点出来；没有就不写。
