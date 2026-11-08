# 第 2 章 多头注意力

Multi-head attention runs several attention functions in parallel. Each head projects queries, keys and values into a smaller subspace, so different heads can specialise in different relations.

## 2.1 头数怎么选

Doubling the number of heads while halving the head dimension keeps the cost roughly constant.
