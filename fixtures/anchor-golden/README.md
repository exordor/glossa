# 锚点黄金测试语料

`packages/source-markdown/test/anchor-golden.test.ts` 用的原文。内容是为测试写的原创文字，故意让术语反复出现（同一个词、同一个短语在多处出现），
考验第三层「引文 + 前后文」消歧。另外也把 `fixtures/sample-book/` 的三章一起测。

改这些文件会改变命中率基线，改完跑一次 `ANCHOR_REPORT=1 pnpm vitest run anchor-golden` 看报告。
