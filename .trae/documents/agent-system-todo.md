# Agent 系统成熟度改造 TODO

> 来源：2026-09-06 对 agent / agent_backend / agent_frontend 三工程的全面审视
> 用法：完成一项把 `[ ]` 改成 `[x]`；优先级 P0（生产硬伤）→ P1（Agent 能力）→ P2（可观测运营）→ P3（工程体系）

---

## P0 — 生产硬伤（建议最先处理）

- [x] **1. 移除硬编码的密钥默认值** ✅ 2026-09-06 完成
  - ~~位置：`agent/src/main/resources/application.yml` 的 `${OPENAI_API_KEY:sk-...}` 默认值；backend yml 的 `${MYSQL_PASSWORD:wasdqew123}`~~
  - 已落地：agent yml `api-key: ${OPENAI_API_KEY:}`（无明文默认值）+ `AgentConfig.requireApiKey()` 启动 fail-fast（缺 key 启动即失败并给出 systemd/本地注入指引，本地已验证）；backend yml `password: ${MYSQL_PASSWORD:}`（缺失时 Hikari 启动即失败）；deploy-test 脚本中的 MySQL 密码改为从 unit 读取/环境变量，不留明文；两个 fat jar 内 application.yml 已验证 grep 不到 `sk-`/密码明文
  - 线上：unit 早已注入 OPENAI_API_KEY / MYSQL_USER / MYSQL_PASSWORD，部署后两服务 active、对话 200，无影响
  - 用户决策（2026-09-06）：git 历史与旧 jar 中的历史 key/密码**不轮换**（私有仓库，评估无泄露风险）；如未来改主意，需在 DeepSeek 控制台作废旧 key、MySQL 改密并更新两个 systemd unit 后 `daemon-reload && restart`

- [x] **2. agent 服务（8080）增加内部鉴权** ✅ 2026-09-06 完成
  - ~~现状：`AgentController` 全部接口零认证，backend 调用也不带凭证~~
  - 已落地：agent 新增 `InternalTokenInterceptor`（拦截 /api/agent/**，校验请求头 `X-Agent-Token`，恒定时间比较；GET /api/agent/health 探活放行；token 未配置则拒绝全部受保护接口）+ `WebConfig` 注册；backend `AgentClient` 经 RestClient 请求拦截器对所有调用（含 SSE/RAG）统一注入 token；token 由环境变量 `AGENT_INTERNAL_TOKEN` 注入（生产 systemd 两个 unit 已配同一强随机值，本地默认 dev-internal-token）；熔断器 ignore 4xx（401 配置错误不顶开熔断）
  - 验收（线上实测）：无 token / 错误 token 直连 8080 的 chat/tools/rag 均 401 且有 WARN 审计日志；health 无 token 200；正确 token 200；经 backend 的同步对话/SSE/技能挂载/工具调用全部 200
  - 部署教训：打包必须用 `mvnw clean package`——IDE（jdt.ls）增量编译器会把带"Unresolved compilation problems"的错误 class 写进 target/classes，Maven 增量打包跳过重编译直接打入 jar，导致线上 NoClassDefFoundError 崩溃循环（javap 常量池可见简单名签名）

- [x] **3. 有状态服务无状态化（记忆 / 技能挂载外置）** ✅ 2026-09-06 完成
  - ~~现状：`AgentFactory.memoryStore`（短期上下文+摘要）、`SkillManager.skillRegistry/userSkillMounts` 均为 JVM 内存态；agent 重启后摘要与最近上下文丢失，多实例间状态不共享~~
  - 已落地：
    - agent 侧：`AgentFactory` 移除 `memoryStore`，每次请求按 payload（摘要+近 30 条历史+技能定义）构建请求级记忆/Skill；`SkillManager` 精简为内置技能目录 + 请求级 `resolveSkills()`；`SummarizingChatMemory.restore()` 支持状态重建、`summaryText()` 导出摘要，且压缩时旧摘要合并（不再堆叠）；对话协议新增 `history/summary/skills` 入参，SSE 结束前发 `event: memory` 回传摘要；删除 agent 的技能上传/挂载等状态接口
    - backend 侧：新增 `agent_memory` 表（摘要持久化）；`ChatController` 每次请求从 MySQL 组装状态下发、回合后回写摘要；技能上传/挂载/卸载/删除不再调 agent（MySQL 唯一权威）；`SkillSyncService` 精简为仅内置元数据落库；`AgentClient` 切换为无状态协议并解析 memory 事件
  - 验收：agent 重启后摘要从 `agent_memory` 恢复、近期历史从 `chat_message` 重建（近 30 条）；技能挂载/上传即时生效，agent 重启无丢失、多实例一致
  - 备注：RAG 向量库仍为 InMemory + JSON 快照（多实例不共享），属 P1-9 真向量库范畴；多会话（conversationId）属 P1-8

- [x] **4. 资源边界与容错** ✅ 2026-09-06 完成（4.1-4.4）
  - [x] 4.1 线程池治理：backend `ChatController`（8/32/队列200）与 agent `AgentController`（8/24/队列100）改为有界 `ThreadPoolExecutor` + AbortPolicy（满载 503 快速失败）+ 命名线程 + `@PreDestroy` 关闭
  - [x] 4.2 SSE 超时：两端 `SseEmitter` 改 5 分钟超时 + `onTimeout` 主动 completeWithError，队列满拒绝时返回 503
  - [x] 4.3 HTTP 客户端：`AgentClient` 换 JDK `HttpClient`（HTTP/2 连接池 + 8 线程响应池）+ `JdkClientHttpRequestFactory`
  - [x] 4.4 韧性：Resilience4j 熔断（20 次窗口/50% 失败率/OPEN 30s/半开 3 次探测，慢调用不计熔断、4xx 不计失败）+ 重试（2 次尝试/间隔 1s，仅连接失败·读超时·5xx）；同步对话 CB(retry(...)) 包装、SSE 仅熔断、RAG 仅熔断；熔断打开/调用失败返回 503 友好提示；状态变更与重试有日志
  - [x] 4.5 内存治理：`memoryStore` 已随 P0-3 无状态化消除（记忆请求级重建）；向量库容量监控并入 P1-9
  - 验收：压测下线程/连接数有上限（待压测实测）；agent 宕机/熔断时 backend 返回 503 + AGENT_UNAVAILABLE 友好降级而非裸 500

- [x] **5. 认证体系加固** ✅ 2026-09-09 完成
  - ~~现状：token 为 DB 单值 UUID，无过期、无 refresh、单端登录互踢、无限流~~
  - 已落地（引入 Redis 会话 + 限流，生产验证通过）：
    - 依赖：`spring-boot-starter-data-redis`（Lettuce 单连接），配置段 `spring.data.redis.*`（host/port/password 走 `${REDIS_HOST:localhost}` / `${REDIS_PORT:6379}` / `${REDIS_PASSWORD:}`，密码由 systemd 注入）
    - 会话外置 Redis：`auth:session:{token}` → userId（TTL 7 天 `auth.session-ttl-seconds` 可配，每次有效请求滑动续期）；`auth:user:{userId}` → 活跃 token（新登录顶掉旧会话实现单端互踢，登出即删）；`app_user.token` 列/schema/实体/仓库全部移除（生产库旧列保留未删，无引用）
    - 失败限流：`auth:fail:user:{name}` / `auth:fail:ip:{ip}` 计数（10 分钟窗口），达 `auth.max-failures`(5) 次 → 锁 `auth.lock:*` 15 分钟，锁定期登录/注册返回 429 `RATE_LIMITED`；登录成功清空计数
    - 客户端 IP 取 X-Forwarded-For 首地址，IPv6/IPv4 回环统一为 127.0.0.1（防限流桶分裂）
    - 前后端（PC web + agent_mobile App）零改动：401 统一跳登录、429 展示提示的既有逻辑已覆盖
  - 验收（线上实测 82.156.243.32）：注册/登录 200 下发 token；/me 200；无/伪 token 401；新登录后旧 token 401（互踢）；登出后 token 401；连续 5 次错误密码第 6 次 429、锁定期正确密码也 429；会话 TTL=604800 且请求后滑动续期；nginx HTTPS 链路 200
  - 部署：腾讯云新机器 `dnf install redis`（redis-7.2.15，仅监听 127.0.0.1 + requirepass 强随机密码），密码经 `REDIS_PASSWORD` 注入 agent-backend.service，`daemon-reload` 后重启

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

- [x] **7. Agent 循环护栏** ✅ 2026-09-09 完成（7.1-7.3 线上实测）
  - [x] 7.1 工具调用轮次上限：`AiServices.builder().maxToolCallingRoundTrips(n)`，参数 `agent.loop.max-tool-round-trips`（默认 15，原库默认 100 太高）；超限（同步/流式）收敛为友好提示"已达到最大工具调用轮次，已自动中止以避免死循环"而非 500
  - [x] 7.2 中断真正传播：前端 AbortSignal（PC ChatPage 新增停止按钮；App 原有 close）→ backend `AgentClient.chatStream` 暴露响应体流引用，`ChatController` 挂 onError/onCompletion/onTimeout 主动 close 流取消对 agent 请求 → agent `AgentController` 请求级 `cancelled` 标记 + 线程 interrupt，token 回调检测取消即抛异常终止 LLM 生成
  - [x] 7.3 LLM 失败重试 + fallback：`AgentConfig` 构建主/备用两套 ChatModel + StreamingChatModel（`fallback-model-name` 默认 deepseek-chat，环境变量 OPENAI_FALLBACK_MODEL 可配）；同步对话主模型失败自动降级备用模型重试一次；流式仅在「未输出任何 token 前」失败才降级（避免重复输出）
  - 配套：流式模型补挂 ReActLoggerListener（原缺口），同步/流式统一可观测；onError 去重防刷屏
  - 验收（线上实测 82.156.243.32）：死循环 prompt 触发工具循环 → 15 轮截断返回收敛提示；流式生成中断开连接 → agent 日志确认 LLM 调用被取消（"[ReAct] LLM 调用出错: 客户端已断开，取消生成"）且流线程释放；主模型临时改为不存在的模型 → 对话降级备用模型正常回答"1+1等于2"

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
