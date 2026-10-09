# Agent 平台成熟度评估与演进建议

> 评估日期：2026-10-09
> 评估范围：agent（智能体服务）、agent_backend（业务后端）、agent_frontend（PC Web）、agent_mobile（Expo 移动端）
> 结论：底座成熟度已不低，短板集中在工程基建（测试/迁移/CI/配额）与平台化能力（开放 API、异步任务、评测闭环）。

---

## 一、现状盘点（已具备的能力）

| 领域 | 现状 |
| --- | --- |
| Agent 架构 | 无状态化：摘要 + 近 30 条历史随请求下发，多实例/重启不丢上下文；请求级动态 Skill 装配与 System Prompt 拼接 |
| 模型韧性 | 主/备模型自动降级（同步 + 流式），Resilience4j 熔断/重试（20 调用窗口、50% 阈值、30s open），HTTP/2 连接池 |
| 工具安全 | 工具 deny-by-default 显式登记；高危工具 HITL 人工审批（60s 超时拒绝）；SSRF 双防（UrlSafetyGuard + HTTP 方法白名单） |
| 代码沙箱 | systemd-run 瞬态单元：DynamicUser + PrivateNetwork + 内存/CPU/进程/时长 cgroup 限制，sudoers 最小放行，默认休眠 |
| RAG | BGE-small-zh 本地 embedding；pgvector 生产存储；向量 + pg_trgm 关键词混合召回 → RRF → bge-reranker 精排；编号引用 |
| 文档解析 | Tika 支持 PDF/Office/HTML，20MB 限制，解析炸弹防护（50 万字/60s 超时） |
| MCP | 已具备 Streamable HTTP / stdio client 能力与安全 ToolProvider（当前默认空列表休眠） |
| 多端 | PC（React + Ant Design v6，流式 SSE）、移动端（Expo / React Native） |
| 可观测 | traceId 全链路；llm/tool/rag 三类审计表落 MySQL；Prometheus + Grafana 14 面板（含 p95）；token 成本核算 |
| 运营基础 | 多会话、知识库管理、Skill 挂载、赞/踩反馈与原因码、管理员白名单后台、用量页 |
| 部署 | systemd 托管、环境变量注入密钥（fail-fast）、nginx、单机 4c4g（JVM 堆 768m/512m） |

---

## 二、差距清单（按优先级）

### P0｜工程基建缺口：成本低、风险高，建议先补

1. **backend 零单测**
   - 现状：agent 侧有 10+ 测试类（审批门、混合召回排序、URL 安全、MCP 安全等），agent_backend 无 test 目录。
   - 风险：ChatController 的 payload 组装、反馈赞踩互斥、AgentClient 降级路径均无回归保护，与"先跑单测再提 PR"的节奏冲突。
   - 建议：优先覆盖 ChatController/ConversationController、FeedbackService、AgentClient（mock HTTP）、BillingService 边界。

2. **数据库迁移无版本管理**
   - 现状：`schema.sql` 仅 `CREATE TABLE IF NOT EXISTS`，新增列靠手工 ALTER（chat_message.trace_id、rag channel/rerank_score 都踩过）。
   - 建议：引入 Flyway，存量 schema 收为 V1 基线，后续变更一律版本化迁移；废弃手工迁移脚本的使用场景。

3. **没有 CI**
   - 现状：四个仓库均无流水线配置。
   - 建议：最低配 GitHub Actions——两个 Java 仓 `mvn clean test`（强制 clean，避免 IDE 增量编译污染产物），前端 `pnpm build`，移动端 `tsc` 类型检查。

4. **~~用户级限流/配额缺失（真金白银的口子）~~ ✅ 已完成（2026-10-09，P0-4）**
   - 实现：`ratelimit` 包三道闸门（按用户名）——每分钟请求数 20（Redis Lua 原子计数窗口）、同时在途对话 4（INCR/DECR + 360s 兜底 TTL，SSE 异步分发结束后释放）、每日 token 预算 200 万（llm_usage_record 当日聚合）。
   - 行为：超额统一 429 + Retry-After + 错误码（RATE_LIMITED / TOO_MANY_CONCURRENT / DAILY_BUDGET_EXCEEDED）；管理员白名单豁免；阈值全部走 env（RATELIMIT_*），总开关可应急关闭；Redis/MySQL 故障 fail-open。
   - 覆盖：拦截器仅挂 /api/chat 与 /api/chat/stream；PC 端直接弹后端文案，移动端 EventSource 读不到响应体，按 429 状态码映射统一提示；指标 backend.ratelimit.rejected{reason}。
   - 测试：RateLimitServiceTest（12）+ RateLimitInterceptorTest（4）共 16 个单测全绿。注意本机 JDK 26 禁止 Mockito 动态 self-attach，pom 已配 surefire `-javaagent:mockito-core`（JDK 21 无副作用）。

### P1｜从"能跑"到"敢长期跑"

5. **告警只有看板没有铃**
   - 为熔断 open、agent 5xx/AGENT_UNAVAILABLE、chat p95 飙升、日成本突增、磁盘/swap 用量配置 Grafana/Alertmanager 告警通道（webhook → 飞书/邮件）。

6. **长任务受 SSE 5 分钟硬超时限制**
   - 现状：agent/backend 两侧 SseEmitter 固定 5min 超时。
   - 建议：异步任务模式（提交 → 任务表 → 后台执行 → 轮询/推送结果），同时作为"定时 agent"的前置能力。

7. **移动端无推送**
   - 现状：未接 expo-notifications。
   - 后果：App 进后台后，60s 的高危审批窗口用户无法响应；异步任务完成也无通知。
   - 建议：接入 Expo Push，先覆盖"待审批提醒"和"任务完成通知"两个场景。

8. **~~纯文本单模态~~ ✅ 已完成（2026-10-09，P1-8）**
   - 背景：DeepSeek `deepseek-flash`（请求名 deepseek-v4-flash 由其承接）已原生支持视觉，标准 OpenAI 兼容 image_url，JPEG/PNG/GIF/WebP，图片仅允许出现在 user 消息，单图 32MiB——无需双模型路由。
   - Agent 侧：AiService 入参改为 `@UserMessage List<Content>`（LC4j 1.17.2 契约；传 String 模板/UserMessage 对象只会被 toString）；ImageContent 显式 DetailLevel.AUTO（默认 LOW 会缩到 512×512）；记忆重建保留图片且纯图片消息不被空白过滤；摘要压缩只取 TextContent（base64 不进摘要 prompt）；新增 TextFirstRetrievalAugmentor 替代 DefaultRetrievalAugmentor（后者 singleText() 在多 content 时返回 null 会打挂 RAG），纯图片回合跳过 RAG；NumberedCitationContentInjector 注入资料时保留图片；ReAct 日志只打文本+[图片×N]；agent 侧防御性校验（数量/MIME/base64/大小）。
   - Backend：chat_attachment 元数据表 + 磁盘存储（`{CHAT_IMAGE_DIR:data/chat-images}/{user}/{uuid}.ext`，防路径穿越）；ChatImageValidator 做 magic bytes 与声明 MIME 一致性校验（上限默认 3 张/5MB，env CHAT_IMAGE_* 可调）；GET /api/chat/attachments/{id} 鉴权取图（owner 校验，Cache-Control private）；近 30 条历史带图重建 agent payload；删除会话同步清理文件；非法图片 400/413；纯图片回合 agent 收到兜底指令文本。
   - PC 前端：输入框图片按钮 + 缩略图预览/移除，乐观气泡本地 dataURL，历史图片经 fetchAuthBlob→objectURL 展示（AntD Image 灯箱预览）；纯图片可直接发送。
   - 测试：agent 87（+9，含"AiServices 确实把 ImageContent 送进 ChatRequest"实证）、backend 29（+13）；两仓 pom 均配 surefire `-javaagent:mockito-core`（JDK 26）。
   - 部署：systemd 加 CHAT_IMAGE_DIR=/opt/agent-data/chat-images（建目录、agent-backend 用户可写）；nginx 25m body 限制满足 3×5MB base64≈20MB。
   - 待办：移动端 agent_mobile 图片选择/发送未做；上线后需用真实截图跑一次端到端读图验证（detail=auto 透传）。

### P2｜平台化能力分水岭

9. **定时/主动 Agent**
   - "每天早上发摘要""网页变更提醒"等被动回话无法覆盖的场景。
   - 实现要点：backend cron 调度（复用 Redis 分布式锁）、任务定义表、执行态管理、结果经推送/SSE 触达。

10. **开放 API + per-user API Key**
    - 外部程序目前无法以用户身份调用 agent——这是"聊天应用"与"agent 平台"的分界线。
    - 实现要点：复用现有用户体系签发可吊销 key；中间件鉴权 + 按 key 计量（llm_usage_record 已支持按用户聚合）；独立限流配额与文档页。

11. **评测闭环（eval）**
    - 现状：message_feedback 采集了赞踩 + 原因码，但只在后台展示，未转化为回归资产。
    - 建议：点踩 case → 黄金问答集；换模型/改 prompt 时离线评测（回答正确性、工具调用成功率、RAG 命中率，原始数据 rag_recall_record 已具备）。

12. **Prompt/模型运营**
    - System Prompt 硬编码在 AgentFactory，无版本、无灰度；模型仅主/备两档。
    - 建议：Prompt 配置化 + 版本管理；按任务复杂度路由（简单走 flash 省钱、复杂走强模型）；提供 prompt playground。

### P3｜知识库 / Skill 生态

13. **知识库增强**：文档增量更新与重建索引（现仅支持删除重传）、URL 抓取入库、召回质量测试视图、文档级更细的权限模型。
14. **Skill/MCP 运营**：MCP server 配置写死在 application.yml（改动需重启）；skill 无版本号；缺用户自助接入 MCP、第三方 OAuth 凭证绑定与共享市场。
15. **会话资产**：会话分享链接；代码沙箱 artifact（文件/图表下载、结果画布）。

### P4｜安全合规与规模化

16. 高危操作独立审计后台（审批/授权数据已有，缺管理视图）。
17. 输入/输出内容安全（敏感信息泄露、prompt 注入检测；接入 http-api 与 code-runner 后风险上升）。
18. 账号注销与数据导出（隐私合规标配）。
19. 容器化与水平扩展：agent 已无状态、RAG 已外置 pgvector，具备条件；目前为 systemd 单机 + scp 部署，多实例还需解决 SSE 粘性（或改无状态轮询）与镜像化发布。

---

## 三、建议实施顺序

结合单机部署（4c4g）与团队现状（后端主导、带两名 junior）：

```
P0 四件套（backend 单测 → Flyway 基线 → GitHub Actions CI → 用户配额限流）
  ↓
P1 告警通道 + 移动推送/异步任务
  ↓
P2 开放 API Key → 评测闭环 → 定时 Agent / 多模态（按需）
  ↓
P3/P4 生态与合规项（按实际用户需求驱动）
```

分工建议：

- **P0-1/2/3**（单测、Flyway、CI）：纯工程动作、风险极低，适合拆给 junior，按"先单测通过再提 PR"节奏推进。
- **P0-4 配额限流**：涉及计费策略判断，由负责人把关阈值与超限产品行为。
- **P1 异步任务/推送**：需要前后端 + 移动端联动，适合作为一个完整里程碑。

---

## 四、关键代码索引

- Agent 装配与 System Prompt：`agent/src/main/java/com/example/agent/agent/AgentFactory.java`
- 循环护栏/审批/沙箱配置：`agent/src/main/resources/application.yml`
- 成本核算：`agent_backend/src/main/java/com/example/backend/billing/BillingService.java`
- 登录限流（唯一现存限流）：`agent_backend/src/main/java/com/example/backend/auth/LoginRateLimiter.java`
- 建表脚本（含手工 ALTER 注释）：`agent_backend/src/main/resources/schema.sql`
- agent 侧测试参考：`agent/src/test/java/com/example/agent/`
- 移动端对话页：`agent_mobile/src/screens/ChatScreen.tsx`
