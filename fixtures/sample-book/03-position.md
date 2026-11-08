# 第 3 章 位置编码

Self-attention by itself is permutation-invariant: shuffling the tokens shuffles the outputs in the same way. Positional encodings break this symmetry.

| 方法 | 是否可外推 |
| --- | --- |
| 正弦编码 | 部分 |
| 可学习编码 | 否 |
| RoPE | 是 |
