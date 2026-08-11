
# 自建Harness Engineering研发工作流

## 思路与想法
目前使用过openspec、Superpowers、matt 的skills 等等，他们的工作流各有优势，都是某一方面强，不够全面，因此我想要构建一套自己的工作路，不是从头造每一个skill，而是将这些优秀的项目下的skill重新整合起来，取各自适合我的skill，重新按照流程串联起来，而不是重复造轮子

## 期望的工作流
- 绿地/宗地需求：聊清楚需求（与AI脑暴） -> 输出需求spec（BDD模式）-> 开始做设计（与AI脑暴）-> 输出设计Design文档 -> 开始做计划 -> 输出plans -> 实施（多Agent协作，TDD模式）-> 测试验证 -> 收尾 

- **每个阶段的补充说明**：
    - 1、聊清楚需求，这个环节像Superpowers的头脑风暴的形式比较好，这里聊需求更多的是站在业务的视角，将需求澄清，输出的是spec文档，像openspec这块就做的比较好
    - 2、实现设计这块是Superpowers的强项，主要是头脑风暴的技能来澄清设计，最终落成Design文档
    - 3、实施计划的编写，也是Superpowers的强项，能够根据 Spec 、Design 编写实施计划plans，plans需要有给人看的一篇md文档，也需要有给ai用的，按照task切分的独立的任务文档，这样在子Agent执行的时候，就能够有更精准任务粒度的上下文，执行时也更加聚焦，也方便后续review代码
    - 4、实施过程中的多Agent协作，Superpowers的subagent太重了，每个任务都会多轮实施+多个review Agent去验证，这里执行的效率非常低，优势是代码质量高，看下如何设计一下，我觉得可以 实施 -> Code Review 两个Agent协作即可，这里可以借鉴一下openspec、Superpowers、matt 的skills或者其他优秀的工作流的实现。让实施阶段所有任务都开发完成后，需要再让coder reviewer进行一次整体性的CR
    - 5、测试验收环节，我希望有一个TE测试工程师的角色，能够从Spec + Design的视角，进行集成测试 和 e2e测试（即：补充集成测试用例 和 e2e 测试用例，并验证通过）
    - 6、收尾，代码分支相关的收尾，提交、推送、PR 等，可以参考Superpowers的收尾skill

- **考虑针对工作流设置相互制衡的Agent设计**
    - 主Agent，负责写Spec、Design、Plans，在头脑风暴做Spec、Design的时候，会在会话过程中频繁与用户交流，因此没法让独立的Agent角色来做Spec、Design，可以考虑新增一个 BA-业务分析师、SA方案架构师 来Review
    - BA-业务分析师 review Spec
    - SA方案架构师 review Design、Plans
    - Dev实施工程师 按照任务实施 + 编写单元测试自测
    - CR代码审查员 方案的一致性检查 + 需求覆盖矩阵
    - TE测试工程师 集成测试、e2e spec测试
    - 收尾最后也可以让主Agent来做，后续再考虑增加一个收尾的子Agent
    > 可以参考 ./zhangle.md 张乐老师的Harness Engineering设计的思路
