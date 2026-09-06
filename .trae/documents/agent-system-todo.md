# Agent 系统成熟度改造 TODO

> 来源：2026-09-06 对 agent / agent_backend / agent_frontend 三工程的全面审视
> 用法：完成一项把 `[ ]` 改成 `[x]`；优先级 P0（生产硬伤）→ P1（Agent 能力）→ P2（可观测运营）→ P3（工程体系）

---

## P0 — 生产硬伤（建议最先处理）

- [ ] **1. 移除硬编码的 LLM API Key**
  - 位置：`agent/src/main/resources/application.yml` 第 16 行 `${OPENAI_API_KEY:sk-...}` 默认值
  - 动作：作废已泄露的 DeepSeek key → 移除配置中的默认值（仅保留环境变量注入）→ 排查/清理 git 历史中的 key
  - 验收：代码与 jar 中 grep 不到任何 `sk-` 开头的密钥

- [ ] **2. agent 服务（8080）增加内部鉴权**
  - 现状：`AgentController` 全部接口（聊天/技能上传/挂载/RAG 索引）零认证，backend 调用也不带凭证
  - 动作：agent 侧加拦截器校验内部 token（请求头），backend 的 `AgentClient` 统一注入该 token；或上 mTLS
  - 验收：无 token 直连 8080 任意接口返回 401；backend 正常调用不受影响

- [ ] **3. 有状态服务无状态化（记忆 / 技能挂载外置）**
  - 现状：`AgentFactory.memoryStore`（短期上下文+摘要）、`SkillManager.skillRegistry/userSkillMounts` 均为 JVM 内存态；agent 重启后摘要与最近上下文丢失，多实例间状态不共享
  - 动作：以 backend + DB/Redis 为唯一事实源；agent 启动/请求时按 userId（或 conversationId）加载记忆，技能挂载关系从 backend 获取；内存态仅作缓存
  - 验收：agent 重启后对话上下文不丢失（从存储恢复）；双实例挂载/记忆一致

- [ ] **4. 资源边界与容错**
  - [ ] 4.1 线程池治理：backend `ChatController` 与 agent `AgentController` 的 `newCachedThreadPool` 改为有界线程池（核心/最大线程、队列上限、拒绝策略）
  - [ ] 4.2 SSE 超时：`SseEmitter(0L)` 改为合理超时 + 断连清理
  - [ ] 4.3 HTTP 客户端：`AgentClient` 的 `SimpleClientHttpRequestFactory` 换带连接池的实现（如 JDK HttpClient / OkHttp）
  - [ ] 4.4 韧性：agent 调用增加重试 + 熔断（Resilience4j），故障不传导给用户
  - [ ] 4.5 内存治理：`memoryStore` 空闲记忆淘汰策略；向量库容量监控
  - 验收：压测下线程/连接数有上限；agent 宕机时 backend 返回友好降级响应而非 500

- [ ] **5. 认证体系加固**
  - 现状：token 为 DB 单值 UUID，无过期、无 refresh、单端登录互踢、无限流
  - 动作：改为 JWT（access token 短期 + refresh token）或加过期时间与续期；登录/注册接口加速率限制防暴力破解
  - 验收：token 过期自动跳转登录；连续错误登录被限流

---

## P1 — Agent 能力短板

- [ ] **6. 扩充工具生态**
  - 现状：`ToolRegistry` 仅 calculatorTools、dateTimeTools 两个玩具工具；Skill 只能引用编译期内置类
  - 动作（按需选型）：
    - [ ] 6.1 联网搜索 / 网页抓取工具（DeepSeek 自身无联网，补时效性）
    - [ ] 6.2 通用 HTTP 请求工具（调第三方 API）
    - [ ] 6.3 代码执行沙箱（Python/Shell，容器隔离，限制 CPU/内存/网络/时长）
    - [ ] 6.4 **MCP 协议支持**（接入外部工具生态的事实标准，收益最大）
  - 安全前提：危险工具（HTTP/执行命令）必须配权限控制 + 人工确认（human-in-the-loop）
  - 验收：新工具可通过 Skill 机制挂载；高危操作前端弹确认后才执行

- [ ] **7. Agent 循环护栏**
  - [ ] 7.1 工具调用最大轮次限制（防止模型死循环烧 token），超限后强制收敛回复
  - [ ] 7.2 中断真正传播：前端 AbortSignal → backend 断连 → agent 侧 LLM 调用真正取消（当前 backend 断开后 agent 仍继续生成）
  - [ ] 7.3 LLM 调用失败重试 + fallback 备用模型（主模型限流/故障时降级）
  - 验收：构造死循环 prompt 时轮次有上限；点"停止"后 agent 日志确认生成终止

- [ ] **8. 多会话（conversation）支持**
  - 现状：memoryId = userId，一个用户只有一条平铺对话线
  - 动作：backend 新增 conversation 表（新建/切换/重命名/删除会话）；memoryId 与 RAG 过滤改为 conversationId（或 userId+conversationId）；前端加会话列表
  - 验收：可新建多个独立会话，互不串上下文；历史按会话分组加载

- [ ] **9. RAG 生产级升级**
  - 现状：`RagService` 用 InMemoryEmbeddingStore + 全量 JSON 快照；仅支持 txt/md；纯向量召回；无来源引用
  - 动作：
    - [ ] 9.1 向量库换 PGVector / Milvus / Redis Stack（解决内存与全量序列化瓶颈）
    - [ ] 9.2 文档解析扩展：PDF / Word / Excel / HTML
    - [ ] 9.3 混合检索：BM25 关键词 + 向量召回 + Rerank 重排序
    - [ ] 9.4 **答案引用来源（citation）**：回答标注来自哪个文档哪一段，可点击核验
    - [ ] 9.5 检索过程可见：前端展示召回片段与相似度分数
  - 验收：上传 PDF 可检索；专业术语/编号类查询能命中；回答附带来源卡片

---

## P2 — 可观测性与运营

- [ ] **10. 全链路可观测**
  - 现状：仅 `ReActLoggerListener` 打印控制台日志
  - 动作：
    - [ ] 10.1 全链路 traceId（frontend → backend → agent → LLM → 工具），日志可串联
    - [ ] 10.2 Micrometer + Prometheus 指标：延迟、QPS、错误率、工具成功率、RAG 命中率
    - [ ] 10.3 **Token 用量与成本统计**（按用户/会话/模型记录，可出账单）
    - [ ] 10.4 工具调用记录、RAG 召回记录落库审计
    - [ ] 10.5 前端可视化：思考过程 / 工具调用 / 知识召回折叠面板（类 ChatGPT、Dify trace）
  - 验收：一次请求能用 traceId 拼出完整链路；能查到每用户 token 消耗

- [ ] **11. 反馈与评估闭环**
  - [ ] 11.1 答案点赞/点踩 + bad case 收集落库
  - [ ] 11.2 建立 eval 数据集（RAG 召回率、回答质量、工具调用正确率），回归测试
  - [ ] 11.3 Prompt / Skill 版本管理与 A/B 对比，改 prompt 不再"靠手感"
  - 验收：点踩的 bad case 可在后台检索；prompt 变更有 eval 报告对比

---

## P3 — 工程体系

- [ ] **12. 测试与 CI/CD**
  - 现状：三个工程零测试类；部署靠手动 scp
  - 动作：
    - [ ] 12.1 核心单测：Skill JSON 解析、RAG 切块/检索/快照、SummarizingChatMemory 压缩、SSE 转发
    - [ ] 12.2 CI 流水线（构建 + 测试 + 打包），CD 对接现有 systemd 部署脚本
  - 验收：`mvn test` 有可通过的用例；推送后流水线自动构建

- [ ] **13. 其他工程项**
  - [ ] 13.1 DB schema 迁移工具：手写 schema.sql → Flyway / Liquibase
  - [ ] 13.2 OpenAPI / Swagger 接口文档
  - [ ] 13.3 模型 / Prompt / RAG 参数管理后台（当前全部硬编码在 yml）
  - [ ] 13.4 Skill 上传安全：自定义 systemPrompt 等于用户可注入系统指令，需审核机制或沙箱隔离

---

## 建议落地节奏

| 阶段 | 内容 | 对应条目 |
|---|---|---|
| 马上 | 密钥清理、agent 鉴权、资源上限、调用重试 | 1、2、4 |
| 短期 | 状态外置无状态化、Agent 护栏、多会话 | 3、7、8、5 |
| 中期 | MCP/工具生态、RAG 升级、token 成本 | 6、9、10.3 |
| 长期 | 可观测平台、eval 体系、CI/CD、迁移工具 | 10、11、12、13 |
