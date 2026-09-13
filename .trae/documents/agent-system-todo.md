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

- [ ] **6. 扩充工具生态**  <!-- 2026-09-12 21:10 三端已部署生产（agent/backend jar + 前端），57 单测；Bing 出网 200/0.32s，审批接口 401/404/400 实测；仅剩用户侧弹窗全链路实测后勾选；回滚 jar：*.bak-20260912 -->
  - 原现状：`ToolRegistry` 仅 calculatorTools、dateTimeTools 两个玩具工具；Skill 只能引用编译期内置类
  - [ ] 6.1 联网搜索 / 网页抓取工具（DeepSeek 自身无联网，补时效性）✅ 内置技能 `web`：免 Key 搜索（cn.bing.com→DuckDuckGo 顺序回退，jsoup 解析）+ fetchWebPage 正文提取；搜索免确认、抓取逐次确认；SSRF 防护（私网/元数据/IPv6/逐跳重定向/2MB 上限）
  - [ ] 6.2 通用 HTTP 请求工具（调第三方 API）✅ 内置技能 `http-api`：GET/POST/PUT/PATCH/DELETE 白名单、不支持自定义请求头、逐次人工确认
  - [x] 6.3 代码执行沙箱（Python/Shell，容器隔离，限制 CPU/内存/网络/时长）✅ 2026-09-13 上线（生产实测通过）：**放弃容器路线改 systemd-run 原生沙箱**（OpenCloudOS 9 / systemd 255，免装 Docker），内置技能 `code-runner`，仅 Python（v1），默认 `agent.tools.code.enabled=false` 休眠（生产经 unit 注入 AGENT_TOOLS_CODE_ENABLED=true 开启）
    - 落地：agent 新增 `tools/code/`（CodeToolsProperties/CodeSandboxService/CodeExecutionTools）+ `skill/impl/CodeRunnerSkill`；每次执行经 `systemd-run --collect --wait --pipe` 起一次性 transient unit：DynamicUser + PrivateNetwork（完全断网）+ ProtectSystem=strict/ProtectHome/PrivateTmp + CapabilityBoundingSet 空 + NoNewPrivileges + MemoryDenyWriteExecute + MemoryMax=256M/CPUQuota=100%/TasksMax=64/RuntimeMaxSec=30（到点杀整个 cgroup，fork 子进程不漏网）+ `python3 -I`（脚本靠 755/644 DAC 只读，**未用** --bind-read-only——OpenCloudOS 9 的 systemd-run 不识别该选项，首跑踩坑后移除）；生产 agent 以非 root 用户 agent 运行 → sudoers 白名单调参数固定的 wrapper `/opt/agent-sandbox/run-sandbox`（readlink -f + /opt/agent-data/sandbox 白名单防注入/穿越）；Linux 找不到 systemd-run 启动 fail-fast 不静默降级，非 Linux auto 回退 direct（启动 WARN，无隔离仅供本地）
    - 资源/取消：Semaphore 并发上限默认 1（满载友好提示）、stdout/stderr 合并 8000 字符截断（超限继续排空防管道阻塞）、Java waitFor 超时+10s 兜底、中断（7.2 停止传播）时 destroyForcibly；退出码 137/143 分类提示（OOM/超时）；临时 .py 用后即删
    - 审批：executePython 登记 CONFIRM/high（ToolRiskPolicy），弹窗预览完整代码；codeExecutionTools 注册进 ToolRegistry 可被自定义 Skill 引用；PC 审批弹窗 pre 补显式等宽字体（App 零改动，原超时拒绝降级不变）
    - backend 零代码改动：条件 Skill Bean 经 /api/agent/skills/catalog 自动收录，重启 backend 后 syncBuiltinCatalog 落库 code-runner 行（日志确认），挂载后 agent 以代码内置定义为准
    - 部署脚本（`agent/deploy-test/`）：`code-sandbox-setup.sh`（装 python3+numpy、wrapper、sudoers.d、unit 注入开关/CODE_SANDBOX_DIR、重启校验注册，幂等）；`code-sandbox-attacks.sh`（10 项断言，含"执行器报错 vs 沙箱真杀"区分防假阳性）；`code-sandbox-e2e.sh`（临时用户全链路冒烟，trap 清库）
    - 生产验收（82.156.243.32，2026-09-13）：attacks 10/10——正常执行、死循环精确 30s 杀（rc=1）、fork 炸弹 31s cgroup 整组杀、2GB 申请 OOM、urllib 断网 URLError、写 /etc 拒绝、os.system 子进程同受限、双沙箱并发 2s 完成、numpy 在 MemoryDenyWriteExecute 下正常、agent 用户 sudo wrapper 路径通；E2E 7/7——SSE 审批弹窗→批准后回复含 56088、拒绝后无 778743 且 agent 日志 approved=false；沙箱目录/transient unit 无残留；agent/backend active + 8080/8081/nginx HTTPS 全 200；57 单测通过、PC tsc+vite build 通过
    - 回滚：jar 回滚备份 `/opt/agent/agent.jar.bak-20260913`（上线前版本）；功能级回滚 = unit 删 AGENT_TOOLS_CODE_ENABLED/CODE_SANDBOX_DIR 两行重启（回休眠，wrapper/sudoers 可留）
  - [ ] 6.4 **MCP 协议支持**（接入外部工具生态的事实标准，收益最大）✅ langchain4j-mcp 1.17.2-beta27；`agent.mcp.servers[]` 配置（stdio/Streamable HTTP），每个 server 动态内置技能 `mcp:{name}`，默认空配置休眠；approval=confirm（默认，走同一审批流）/auto
  - 安全前提：危险工具（HTTP/执行命令）必须配权限控制 + 人工确认（human-in-the-loop）✅ 已落地：SSE `approval-request` + POST /api/agent/approvals/{id}/decision（X-Agent-Token + userId 归属校验，404/409）；拒绝/60s 超时/断连全部安全收敛；agent 保持无状态，「本会话始终允许」存 backend Redis（tool:grant:{user}:{conv}，TTL 7 天）随 payload.allowedTools 下发；PC 端 Modal 确认，App 端安全降级（超时拒绝）
  - 验收：新工具可通过 Skill 机制挂载；高危操作前端弹确认后才执行 —— 待三端部署后线上实测（搜索源国内可达性、审批全链路、MCP 实接名单）；规格见 .trae/specs/p1-6-tools-ecosystem/

- [x] **7. Agent 循环护栏** ✅ 2026-09-09 完成（7.1-7.3 线上实测）
  - [x] 7.1 工具调用轮次上限：`AiServices.builder().maxToolCallingRoundTrips(n)`，参数 `agent.loop.max-tool-round-trips`（默认 15，原库默认 100 太高）；超限（同步/流式）收敛为友好提示"已达到最大工具调用轮次，已自动中止以避免死循环"而非 500
  - [x] 7.2 中断真正传播：前端 AbortSignal（PC ChatPage 新增停止按钮；App 原有 close）→ backend `AgentClient.chatStream` 暴露响应体流引用，`ChatController` 挂 onError/onCompletion/onTimeout 主动 close 流取消对 agent 请求 → agent `AgentController` 请求级 `cancelled` 标记 + 线程 interrupt，token 回调检测取消即抛异常终止 LLM 生成
  - [x] 7.3 LLM 失败重试 + fallback：`AgentConfig` 构建主/备用两套 ChatModel + StreamingChatModel（`fallback-model-name` 默认 deepseek-chat，环境变量 OPENAI_FALLBACK_MODEL 可配）；同步对话主模型失败自动降级备用模型重试一次；流式仅在「未输出任何 token 前」失败才降级（避免重复输出）
  - 配套：流式模型补挂 ReActLoggerListener（原缺口），同步/流式统一可观测；onError 去重防刷屏
  - 验收（线上实测 82.156.243.32）：死循环 prompt 触发工具循环 → 15 轮截断返回收敛提示；流式生成中断开连接 → agent 日志确认 LLM 调用被取消（"[ReAct] LLM 调用出错: 客户端已断开，取消生成"）且流线程释放；主模型临时改为不存在的模型 → 对话降级备用模型正常回答"1+1等于2"

- [x] **8. 多会话（conversation）支持** ✅ 2026-09-09 完成（线上实测）
  - 数据模型：新增 `conversation` 表（user_id/title/created_at/updated_at）；`chat_message` 加 `conversation_id`（0=默认/历史会话，多会话上线前遗留数据自动归此）；`agent_memory` 主键改复合 `(user_id, conversation_id)`（摘要按会话隔离）
  - backend 接口：`GET/POST /api/conversations`（列表/新建）、`PATCH/DELETE /api/conversations/{id}`（重命名/级联删除消息+摘要）；`/api/chat/history?conversationId=N` 按会话查；`chat`/`stream` 请求带 conversationId，摘要与近 30 条历史均按 (userId, conversationId) 组装/回写；对话后刷新会话 updated_at
  - agent：payload 新增 conversationId；记忆键 `memoryId = userId + "::" + conversationId`（对话记忆按会话隔离）；RAG 检索仍按 userId（长期记忆跨会话共享，有意保留）
  - 前端：PC ChatPage 新增左侧会话列表面板（新建/切换/重命名/删除，无会话自动建"新对话"）；App ChatScreen 新增"☰ 会话"弹窗列表（切换/新建/重命名/删除）
  - 生产库已 ALTER（chat_message 加列+索引、agent_memory 复合主键），历史数据自动归默认会话 0
  - 验收（线上实测 82.156.243.32）：会话 A 问数学/会话 B 问地理 → 各自 history 完全独立、互不串上下文；重命名/删除（级联清消息）正常；摘要按 (user_id, conversation_id) 复合主键存取

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

- [x] **10. 全链路可观测** ✅ 2026-09-11 完成（生产部署+线上实测）
  - 现状（改造后）：
    - [x] 10.1 全链路 traceId：前端 UUID 上送 X-Trace-Id，两服务 TraceMdcFilter 落 MDC（[%X{traceId}] 日志格式），
      agent 经 HTTP 头透传，agent/backend journal 同 id 可 grep；线程池交接 TraceMdcFilter.wrapWithMdc；
      agent SSE 工作线程 ThreadLocal finally 清理不串号
    - [x] 10.2 指标（actuator + micrometer-registry-prometheus，独立管理端口 18080/18081 绑 127.0.0.1）：
      agent chat/llm(tokens/时长) /tool/rag(命中/片段) /sse.gauge；backend chat/agent.http/sse/
      cb.state/failure_rate；含工具成功率、RAG 命中率；后续可自行抓 Prometheus（未装 Grafana）
    - [x] 10.3 Token 用量与成本：DeepSeek 流式 include_usage 经 TraceAwareStreamingChatModel
      （流式回调跨线程，ThreadLocal 失效故用请求级装饰器显式采集）聚合真实 input/output/轮次/模型；
      llm_usage_record 落库（traceId 唯一幂等、取消行 cancelled=1、fallback 标记）；billing.models
      yml 配 DeepSeek 2026-09 官方单价（deepseek-flash 1/2 元/百万等，未知模型 WARN 记 0）；
      GET /api/usage/summary 按时间/模型/会话聚合；PC「用量统计」页
    - [x] 10.4 审计落库：tool_call_record（参数/结果预览/成败/耗时，id 配对+completedToolIds 去重
      解决多轮历史结果错配）、rag_recall_record（query/来源/文本/score，miss 也落 query-only 行）；
      GET /api/chat/traces/{traceId} 归属校验回查
    - [x] 10.5 PC 可视化：助手气泡「知识召回 N/工具调用 N」折叠面板（来源、相似度%、参数、结果、耗时、
      成败图标）+ 底栏 token/费用/traceId 复制；历史消息「查看思考过程」懒加载（缓存/404 空态）；
      用量统计页（RangePicker+卡片+按模型/按会话表）；fallback 重放经 event:trace-reset 防重复
    - 工程：评审 R1(4major)→R2→R3 三轮闭环；新增 event: trace-reset 协议；
      agent_mobile 零改动（react-native-sse 只收默认事件，自动兼容）
    - 部署：schema 三新表自动建 + chat_message 手工 ALTER trace_id（生产已执行，2026-09-11 前旧消息为 NULL）；
      冒烟测试用户/数据已清理；回滚 jar 备份 agent*.bak-20260911-*、web.bak-20260911-005728
  - 验收（线上实测）：SSE 逐事件 tool 结果 20/60/12 正确、usage 4181 token 费用复算一致；
    traceId 跨两服务 grep 到；同 traceId 用量仅 1 行；越权 trace 404；用量接口对账一致；
    管理端口外部不可达（ss 仅 127.0.0.1）

- [ ] **11. 反馈与评估闭环**
  - [x] 11.1 答案点赞/点踩 + bad case 收集落库 ✅ 2026-09-13 完成并部署生产（管理员 zlf；待用户浏览器实测点赞/点踩与后台页）
    - 落地（仅 PC web + backend，agent/agent_mobile 零改动）：
      - backend 新增 `message_feedback` 表（trace_id+user_id 唯一，rating ±1/原因码/备注，schema.sql 自动建新表无需手工 ALTER）；删除会话级联清反馈
      - `POST /api/feedback`（1 赞/-1 踩/0 取消；再点同一评价=取消；赞踩互斥切换；traceId 归属校验复用 existsByTraceIdAndUserId，非本人/被取消回合 404）；`GET /api/feedback/reasons` 原因码字典；history 接口每条消息批量水合 `feedback`（单次 IN 无 N+1）
      - 管理员白名单：`app.admin.usernames`（环境变量 APP_ADMIN_USERNAMES 逗号分隔，空=fail-closed 全员 403）+ AdminInterceptor 拦 `/api/admin/**`；`/api/auth/me` 与登录/注册响应带 admin 标志；前端启动静默调 /me 刷新
      - 管理后台 `GET /api/admin/feedback`（评分/原因/关键词[匹配备注与问答内容]/时间范围分页，富化问题+答案+会话标题，问答截断 4000 字）与 `/stats`（总数/赞/踩/原因分布）；PC 新增「反馈管理」页（仅管理员可见菜单，直敲 URL 403 空态）
      - PC 助手气泡下 FeedbackBar（点赞即时提交；点踩 Popover 单选原因+可选备注；乐观更新+失败回滚；实时回合结束后与历史消息均可用）；Micrometer `backend.feedback.total{outcome,reason}`
      - 构建验证：backend `mvnw clean package` 通过；前端 tsc -b + vite build 通过
    - 部署（2026-09-13）：新机 agent-backend.jar 已换（备份 agent-backend.jar.bak-20260913，unit 备份 .service.bak-20260913），unit 注入 `APP_ADMIN_USERNAMES=zlf`（第 15 行）后 daemon-reload+restart；旧机前端原子切换（index-D3xXRIa7.js）；agent 服务未动
    - 线上冒烟（临时用户，已清理）：无 token /api/feedback 与 /api/admin/feedback 均 401；注册/me 带 admin=false；reasons 200 且按固定顺序（修复了 Map.copyOf 乱序，改用 Collections.unmodifiableMap(LinkedHashMap)，重新构建替换）；他人 trace 404；rating=5/非法原因码 400；非管理员 admin 两接口 403；message_feedback 表自动创建结构正确；nginx HTTPS 链路 401/401/health 200；公网 zlfshop.xyz 为新 hash；journal 无 error
    - 回滚：jar 回滚备份 .bak-20260913；unit 删第 15 行 APP_ADMIN_USERNAMES 后 daemon-reload+restart（前端旧版已随原子切换删除，需要时从 dist 重新发布）
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
