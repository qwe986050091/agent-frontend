# RAG 检索增强实现计划

## Context

当前系统对话只靠 [SummarizingChatMemory](file:///d:/code/agent/src/main/java/com/example/agent/agent/SummarizingChatMemory.java)（会话内总结），LLM 无法检索用户上传的文档或跨会话的历史对话。用户希望增加 RAG：

* **数据来源**：文档知识库 + 历史对话长期记忆（两者都要）

* **向量存储**：InMemory 内存向量库（先跑通，不引持久化库）

* **Embedding**：**LangChain4j 进程内本地模型** `bge-small-zh-v1.5`（量化版，ONNX 运行时，模型打包在 jar 内）——不调用任何外部 embedding API、无需 key、离线可用，中文语义检索质量好

核心目标是让 agent 在回答时能按用户维度召回相关片段，注入上下文。

## 架构决策

* **Embedding 与向量库都放 agent 工程**（`d:\code\agent`）：因为 RAG 最终要注入 `AiServices` 的 `ContentRetriever`（[AgentFactory.java](file:///d:/code/agent/src/main/java/com/example/agent/agent/AgentFactory.java) 两处 builder），而 LLM 调用也在 agent 端。

* **backend 只做业务编排**（`d:\code\agent_backend`）：接收上传、解析文本、存文档元数据、转发 agent 索引，对话落库后再索引一条。

* **用户隔离**：向量库 TextSegment 的 metadata 带 `userId`，检索时用 `MetadataFilterBuilder` 按当前 userId 过滤。

* **零配置开箱即用**：本地 embedding 不需要 base-url/api-key，模型随 jar 分发；`rag.enabled` 默认 `true`（首次 embedding 时懒加载 ONNX 模型，不拖慢启动）。

* **优雅降级**（参考历史经验）：ONNX 初始化或 embedding 调用失败时，RAG 自动降级为纯聊天（空 retriever + 索引接口报错不中断），日志明确区分"聊天可用"与"RAG 不可用"，绝不让向量库问题拖垮主流程。

* **依赖**：`InMemoryEmbeddingStore`、`DocumentSplitters`、`Content`、`Filter` 已在现有 langchain4j 1.17.2 依赖内；**仅需给 agent 工程新增一个本地 embedding 依赖**（BOM 已管理版本，不写版本号）：

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-embeddings-bge-small-zh-v15-q</artifactId>
</dependency>
```
（量化版，fat jar 约 +100MB；含 ONNX Runtime 本地库，Windows/Linux x86_64 均开箱可用。backend/frontend 无新增依赖。）

## 一、agent 工程（d:\code\agent）— 检索与索引核心

### 0. `pom.xml` 新增本地 embedding 依赖

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-embeddings-bge-small-zh-v15-q</artifactId>
</dependency>
```
（版本由 langchain4j-bom 1.17.2 统一管理；类名 `dev.langchain4j.model.embedding.onnx.bgesmallzhv15q.BgeSmallZhV15QuantizedEmbeddingModel`，实现 `dev.langchain4j.model.embedding.EmbeddingModel`，512 维，模型文件在 jar 内。）

### 1. `src/main/resources/application.yml` 新增

```yaml
rag:
  enabled: true                 # 本地 embedding 零配置，默认开启；置 false 可完全关闭 RAG
  chunk-size: 500               # 中文按字符切块上限
  chunk-overlap: 50
  search:
    max-results: 4
    min-score: 0.5
```
（无需任何 api-key / base-url。）

### 2. 新增 `src/main/java/com/example/agent/config/RagConfig.java`

* `@Configuration @ConditionalOnProperty(prefix="rag", name="enabled", havingValue="true", matchIfMissing=true)`

* 构建 Bean（**懒加载**，首次使用才初始化 ONNX 模型）：

  * `EmbeddingModel embeddingModel()`：返回 `new BgeSmallZhV15QuantizedEmbeddingModel()`；用 supplier/try-catch 包裹，初始化失败时打 WARN 日志并让 Bean 缺失（触发降级），不阻断应用启动。

  * `EmbeddingStore<TextSegment> embeddingStore()`：`new InMemoryEmbeddingStore<>()`

* 从 `@Value("${rag...}")` 读取切块与检索参数注入 RagService。

### 3. 新增 `src/main/java/com/example/agent/rag/RagService.java`

* `RagService(EmbeddingModel, EmbeddingStore<TextSegment>, chunkSize, chunkOverlap, maxResults, minScore)`

* `int indexDocument(String userId, String docId, String sourceName, String text)`：用 `DocumentSplitters` 按字符切块（复用 langchain4j `DocumentSplitters.recursive` 或 `DocumentByParagraphSplitter`），逐段 embedding 写入 store，metadata = `{userId, type:"document", docId, source}`；返回块数。

* `int indexConversation(String userId, String role, String content)`：单条对话短文本作为一段（超长再切），metadata = `{userId, type:"conversation"}`。

* `ContentRetriever retrieverOf(String userId)`：返回自定义 `ContentRetriever`，内部用 `Query.text()` 做向量查询，`EmbeddingSearchRequest.builder().queryEmbedding(...).maxResults().minScore().filter(MetadataFilterBuilder.strictEquals("userId", userId)).build()`，把命中的 `TextSegment` 包装成 `Content`（`DefaultContent.from`）返回 `List<Content>`。

### 4. 新增 `src/main/java/com/example/agent/controller/RagController.java`

* `POST /api/agent/rag/index-document`：body `{userId, docId, name, text}` → 调 RagService，返回 `{chunks}`。

* `POST /api/agent/rag/index-conversation`：body `{userId, role, content}` → 调 RagService。

### 5. 修改 `src/main/java/com/example/agent/agent/AgentFactory.java`

* 构造注入 `ObjectProvider<RagService>`（避免 rag 未启用时 NPE）。

* `chat()` 与 `streamChat()` 的 `AiServices.builder()` 各加 `.contentRetriever(retrieverFor(userId))`：

  * rag 启用 → `ragService.getIfAvailable().retrieverOf(userId)`

  * 未启用 → 返回空内容的 retriever（`query -> List.of()`）。

* 逻辑抽为私有方法 `retrieverFor(String userId)`，两处复用。

## 二、backend 工程（d:\code\agent\_backend）— 编排与元数据

### 6. `src/main/resources/schema.sql` 新增知识文档表

```sql
CREATE TABLE IF NOT EXISTS knowledge_document (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  doc_name VARCHAR(255) NOT NULL,
  doc_type VARCHAR(20) NOT NULL,
  chunk_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  INDEX idx_knowledge_user (username)
)
```

### 7. 新增 `knowledge/KnowledgeDocumentEntity.java` + `KnowledgeDocumentRepository.java`

* 仿 `ChatMessageEntity`/`ChatMessageRepository` 的 JPA 模式；Repository 加 `findByUsernameOrderByIdDesc(String username)`。

### 8. 新增 `knowledge/KnowledgeController.java`（`@RequestMapping("/api/knowledge")`）

* `POST /api/knowledge/upload`：`@RequestParam("file") MultipartFile`（复用 [SkillController](file:///d:/code/agent_backend/src/main/java/com/example/backend/skill/SkillController.java) L83-99 的 multipart 范式）。校验扩展名 `.txt/.md/.text`（暂不支持 PDF，见限制），读 UTF-8 文本，生成 `docId=UUID`，调 `agentClient.indexDocument` 成功后落库 `knowledge_document`。

* `GET /api/knowledge/documents`：返回当前用户文档列表。

* `DELETE /api/knowledge/documents/{id}`：删除该用户元数据（向量遗留见限制说明）。

### 9. 修改 `agent/AgentClient.java`：新增

* `int indexDocument(String userId, String docId, String name, String text)`（POST 至 agent `/api/agent/rag/index-document`）

* `void indexConversation(String userId, String role, String content)`（POST 至 agent `/api/agent/rag/index-conversation`）

* 复用现有 `RestClient`。

### 10. 修改 `chat/ChatController.java`

* 在 `saveMessage(...)` 落库后调用 `agentClient.indexConversation(userId, role, content)`，实现"每轮对话自动进长期记忆"。注意放在子线程或 try-catch 包裹，不阻塞/不破坏主流程（索引失败不影响聊天）。

### 11. 修改 `config/WebConfig.java`

* 把 `/api/knowledge/**` 加入 AuthInterceptor 拦截路径（对齐当前 `/api/chat/**`、`/api/skills/**` 写法）。

## 三、frontend 工程（d:\code\agent_frontend）— 知识库管理页

### 12. 新增 `src/pages/KnowledgePage.tsx`

* 卡片布局 + `Upload.Dragger`（直接复用 [SkillsPage.tsx](file:///d:/code/agent_frontend/src/pages/SkillsPage.tsx) L92-110 的 `customRequest`+FormData 模式），`accept=".txt,.md,.text"`，上传到 `/api/knowledge/upload`。

* 列表展示该用户文档（名称/类型/块数/时间），`Popconfirm` 删除。

* 用 `App.useApp()` 的 message/modal（全局已有 antd App 包装）。

### 13. `src/api.ts` 增加

* `uploadDocument(file)`、`listDocuments()`、`deleteDocument(id)` —— 复用通用 `api()`（自动带 token、透传 FormData）。

### 14. 修改 `src/layouts/MainLayout.tsx` + `src/App.tsx`

* `menuItems` 加 `{ key:'/knowledge', icon:<DatabaseOutlined/>, label:'知识库' }`；header 标题三元加分支。

* `App.tsx` 在受保护区域加 `<Route path="/knowledge" element={<KnowledgePage/>}/>`。

## 关键流程

**文档入库**：前端上传文件 → backend 读文本 → 调 agent `index-document`（切块+embedding 落内存向量库）→ backend 存元数据。

**对话入长期记忆**：backend 每条消息落库后 → 调 agent `index-conversation`（embedding 落向量库）。

**回答时检索**：用户提问 → AgentFactory 用该 userId 的 ContentRetriever 过滤查询向量库 → 召回 top4 片段包装成 Content 注入 AiServices → LLM 结合上下文回答。

## 限制与说明（先跑通阶段可接受）

* **内存向量库重启即丢**：agent 重启后索引清空，需重新上传/重建；后续可换持久化库。

* **删除文档后向量残留**：InMemory 库不支持按 docId 删除，删除仅移除元数据；少量残留可在后续持久化向量库时通过 filter 一并解决。

* **历史对话冷启动**：仅对"启用后"的新对话自动索引；已存在的 `/api/chat/history` 不会自动回灌（可后续加"重建"按钮）。

* **本地 embedding 成本**：bge-small-zh-v1.5 量化版模型随 jar 分发（fat jar 约增大 100MB），首次调用时加载 ONNX 模型（秒级、占几百 MB 内存），CPU 推理即可，无需 GPU；服务器需为 Linux x86_64（当前部署环境满足）。

* **降级行为**：若 ONNX 在某环境加载失败，RAG 自动关闭、聊天不受影响，日志会明确告警。

## 四、2核2G 服务器部署调优（必做，否则 OOM 风险）

本地 ONNX embedding 加载时 agent RSS 增加约 200~350MB。调优目标：典型占用 ~1.4GB、峰值 <1.8GB。

1. **两个 JVM 限堆**：在两个 systemd unit（agent 与 backend 的 `.service`，位于 `/etc/systemd/system/`）的 `Environment=` 中加 `JAVA_OPTS=-Xms128m -Xmx256m -XX:MaxMetaspaceSize=128m`（或直接写在 ExecStart 的 java 参数里），`systemctl daemon-reload && systemctl restart`。
2. **MySQL 降配**：`/etc/my.cnf.d/` 下加 `innodb_buffer_pool_size=128M`、`max_connections=50`，重启 MySQL。
3. **加 2GB swap 兜底**：`fallocate -l 2G /swapfile && chmod 600 && mkswap && swapon`，写入 `/etc/fstab`；`vm.swappiness=10`。
4. **索引异步化**（代码层面减压）：backend 的 `indexConversation` 调用放到已有线程池异步执行（不占聊天请求线程，也不阻塞 SSE）；agent 端 `indexDocument` 用 `embeddingModel.embedAll(segments)` 批量向量化，减少推理次数。
5. ONNX 模型懒加载（首次 embedding 才加载），日常纯聊天不占这部分内存。

## 验证

1. `d:\code\agent`：`./mvnw.cmd -o compile`（含新依赖下载；RagConfig/RagService/RagController/AgentFactory 编译通过）。
2. `d:\code\agent_backend`：`./mvnw.cmd -o compile`（新增实体/Controller/agent client 编译通过）。
3. 本地直接启动三个服务（**无需任何 embedding key/配置**，rag 默认开启）。
4. 前端"知识库"页上传一个 `.txt` 文档 → 观察 agent 日志 chunk 数；在 ChatPage 提问与该文档相关的问题，确认回答能引用文档内容（命中检索）。
5. 连续对话若干条后，在另一轮询问之前聊过的事实，验证长期记忆召回。
6. 置 `rag.enabled=false` 启动，确认对话功能不受影响（回归）。
7. 部署到 2核2G 后：`free -h` 观察上传文档触发 embedding 时的峰值内存与 swap 使用，确认无 OOM kill（`journalctl -u agent` / `dmesg | grep -i oom`）。

