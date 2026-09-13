// 简单的 fetch 封装：自动携带登录 token，统一错误处理

const TOKEN_KEY = 'agent_token'
const USER_KEY = 'agent_user'

export interface AuthUser {
  username: string
  nickname: string
  /** 管理员（白名单驱动，仅控制后台菜单显隐；接口仍由服务端 AdminInterceptor 兜底 403） */
  admin?: boolean
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function saveAuth(token: string, user: AuthUser) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    return null
  }
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// ==================== 多会话（conversation） ====================

export interface Conversation {
  id: number
  title: string
  createdAt?: string
  updatedAt?: string
}

/** 会话列表（含 id=0 默认/历史会话条目，若存在遗留消息） */
export async function listConversations(): Promise<Conversation[]> {
  const data = await api<{ conversations: Conversation[] }>('/api/conversations')
  return data.conversations || []
}

/** 新建会话 */
export async function createConversation(title?: string): Promise<Conversation> {
  return api('/api/conversations', { method: 'POST', body: { title } })
}

/** 重命名会话 */
export async function renameConversation(id: number, title: string): Promise<Conversation> {
  return api(`/api/conversations/${id}`, { method: 'PATCH', body: { title } })
}

/** 删除会话（级联删除其全部消息与摘要） */
export async function deleteConversation(id: number): Promise<void> {
  await api(`/api/conversations/${id}`, { method: 'DELETE' })
}

// ==================== 知识库（RAG 文档） ====================

export interface KnowledgeDoc {
  id: number
  docName: string
  docType: string
  chunkCount: number
  createdAt: string
}

/**
 * 上传知识库文档（.txt/.md）
 *
 * 用 XHR 而非 fetch：需要 upload.onprogress 反馈真实网络上传进度；
 * 注意响应在服务端切块+向量化完成后才返回，进度到 100% 后到收到响应之间
 * 即服务端处理时间（调用方可据此显示"正在向量化"阶段）。
 *
 * @param onProgress 网络上传进度回调，percent 为 0-100
 */
export function uploadDocument(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ id: number; docName: string; chunks: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/knowledge/upload')
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress?.(Math.round((e.loaded / e.total) * 100))
      }
    }

    xhr.onload = () => {
      if (xhr.status === 401) {
        clearAuth()
        if (!location.pathname.startsWith('/login')) location.href = '/login'
        reject(new ApiError('未登录或登录已过期', 401))
        return
      }
      let data: any = {}
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // 非 JSON 响应按错误处理
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data)
      } else {
        reject(new ApiError(data.message || `上传失败 (${xhr.status})`, xhr.status))
      }
    }
    xhr.onerror = () => reject(new ApiError('网络连接失败', 0))

    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  })
}

/** 当前用户的知识库文档列表 */
export async function listDocuments(): Promise<KnowledgeDoc[]> {
  const data = await api<{ documents: KnowledgeDoc[] }>('/api/knowledge/documents')
  return data.documents || []
}

/** 删除知识库文档 */
export async function deleteDocument(id: number): Promise<void> {
  await api(`/api/knowledge/documents/${id}`, { method: 'DELETE' })
}

/** 请求配置：body 允许传普通对象（自动 JSON 序列化）、FormData 或字符串 */
export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: any
}

/**
 * 统一请求方法
 * @param path    接口路径（如 /api/chat）
 * @param options fetch 配置；body 为对象时自动 JSON 序列化，FormData 直接透传
 */
export async function api<T = any>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token

  let body = options.body
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }

  const res = await fetch(path, { ...options, body: body as BodyInit, headers })
  const data = await res.json().catch(() => ({} as any))

  if (res.status === 401) {
    clearAuth()
    if (!path.startsWith('/api/auth/') && !location.pathname.startsWith('/login')) {
      location.href = '/login'
    }
    throw new ApiError(data.message || '未登录或登录已过期', 401)
  }
  if (!res.ok) {
    throw new ApiError(data.message || `请求失败 (${res.status})`, res.status)
  }
  return data as T
}

// ==================== 全链路 trace（P2-10） ====================

export interface ToolTrace {
  round: number
  id?: string
  name: string
  arguments?: string
  result?: string
  success: boolean
  error?: string | null
  durationMs: number
}

export interface RagSegment {
  docId?: string
  source: string
  type: string
  text: string
  score: number
}

export interface RagTrace {
  query: string
  segments: RagSegment[]
}

export interface UsageTrace {
  model?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  rounds: number
  fallback: boolean
  cancelled: boolean
  durationMs: number
  /** backend 转发 usage 事件/历史回查时附加（费用只以后端计算为准） */
  costYuan?: number
}

/** 历史 trace 懒加载返回（GET /api/chat/traces/{traceId}） */
export interface TraceDetail {
  traceId: string
  usage: UsageTrace
  tools: ToolTrace[]
  recalls: RagTrace[]
}

export async function getTrace(traceId: string): Promise<TraceDetail> {
  return api(`/api/chat/traces/${encodeURIComponent(traceId)}`)
}

// ==================== 高危工具人工确认（P1-6） ====================

/** agent 经 SSE approval-request 事件下发的审批请求 */
export interface ApprovalRequestData {
  approvalId: string
  /** LangChain4j 工具名（MCP 工具为原始名） */
  tool: string
  /** low / medium / high */
  riskLevel: string
  /** 中文动作标题（如「发起 HTTP 请求」） */
  title: string
  /** 参数预览（≤500 字符） */
  argsPreview: string
  traceId?: string
  conversationId?: number
}

/**
 * 提交高危工具审批决策。
 * POST /api/chat/approvals/{approvalId}/decision
 * @param remember 批准且勾选「本次会话始终允许」时传 true（backend 写 Redis 会话授权）
 */
export async function decideApproval(
  approvalId: string,
  approved: boolean,
  remember = false,
): Promise<{
  approvalId: string
  state: string
  tool: string
  conversationId: number
  remember: boolean
}> {
  return api(`/api/chat/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    body: { approved, remember },
  })
}

// ==================== 用量统计（P2-10） ====================

export interface UsageTotals {
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costYuan: number
}

export interface ModelUsageRow {
  model: string
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costYuan: number
}

export interface ConversationUsageRow {
  conversationId: number
  title: string | null
  turns: number
  totalTokens: number
  costYuan: number
}

export interface UsageSummary {
  range: { from: string; to: string }
  totals: UsageTotals
  byModel: ModelUsageRow[]
  byConversation: ConversationUsageRow[]
}

/** GET /api/usage/summary?from=yyyy-MM-dd&to=yyyy-MM-dd（默认近 30 天） */
export async function getUsageSummary(from?: string, to?: string): Promise<UsageSummary> {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString()
  return api(`/api/usage/summary${qs ? '?' + qs : ''}`)
}

// ==================== 回答反馈（P2-11.1） ====================

/** 某条助手消息上的反馈状态（history 接口附带） */
export interface FeedbackInfo {
  rating: number // 1=赞，-1=踩
  reasonCode?: string | null
  comment?: string | null
}

export interface FeedbackReason {
  code: string
  label: string
}

/** 点踩原因码字典（GET /api/feedback/reasons） */
export async function getFeedbackReasons(): Promise<FeedbackReason[]> {
  const data = await api<{ reasons: FeedbackReason[] }>('/api/feedback/reasons')
  return data.reasons || []
}

/**
 * 提交反馈。POST /api/feedback
 * @param rating 1=赞，-1=踩，0=取消；重复点当前评价同样按取消处理
 * @returns 提交后的有效评分（取消时为 0）
 */
export async function submitFeedback(
  traceId: string,
  rating: number,
  reasonCode?: string,
  comment?: string,
): Promise<{ traceId: string; rating: number }> {
  return api('/api/feedback', {
    method: 'POST',
    body: { traceId, rating, reasonCode, comment },
  })
}

/** 管理后台反馈行（含问答富化） */
export interface AdminFeedbackRow {
  id: number
  traceId: string
  userId: string
  conversationId: number
  conversationTitle: string
  rating: number
  reasonCode?: string | null
  reasonLabel?: string | null
  comment?: string | null
  question?: string | null
  answer?: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminFeedbackPage {
  content: AdminFeedbackRow[]
  page: number
  size: number
  total: number
  totalPages: number
}

export interface FeedbackReasonStat {
  reasonCode: string | null
  reasonLabel: string | null
  count: number
}

export interface FeedbackStats {
  total: number
  up: number
  down: number
  byReason: FeedbackReasonStat[]
}

export interface FeedbackListParams {
  rating?: number // 1 / -1 / 不传
  reason?: string
  keyword?: string
  from?: string // yyyy-MM-dd
  to?: string
  page?: number
  size?: number
}

/** 管理员分页检索反馈（GET /api/admin/feedback） */
export async function getAdminFeedback(params: FeedbackListParams = {}): Promise<AdminFeedbackPage> {
  const qs = new URLSearchParams()
  if (params.rating !== undefined) qs.set('rating', String(params.rating))
  if (params.reason) qs.set('reason', params.reason)
  if (params.keyword) qs.set('keyword', params.keyword)
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  qs.set('page', String(params.page ?? 0))
  qs.set('size', String(params.size ?? 20))
  return api(`/api/admin/feedback?${qs.toString()}`)
}

/** 管理员反馈统计（GET /api/admin/feedback/stats） */
export async function getFeedbackStats(from?: string, to?: string): Promise<FeedbackStats> {
  const qs = new URLSearchParams()
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  const s = qs.toString()
  return api(`/api/admin/feedback/stats${s ? '?' + s : ''}`)
}

/**
 * 流式对话（SSE）：POST /api/chat/stream
 *
 * 服务端逐 token 推送 text/event-stream，这里用 fetch + ReadableStream
 * 手动解析 SSE（EventSource 不支持 POST 和自定义请求头）。
 *
 * 事件类型：
 *  - 默认事件：token 片段 → onToken
 *  - event: tool/rag/usage：trace 事件 → onTool/onRag/onUsage
 *  - event: memory / data:[DONE]：服务端内部处理/结束标记，不到前端
 *
 * @param handlers.onToken   每收到一个 token 片段回调
 * @param handlers.signal    AbortSignal，用于中断生成
 * @param handlers.onTool    工具调用事件
 * @param handlers.onRag     知识召回事件
 * @param handlers.onUsage   回合用量事件
 * @param handlers.onApproval 高危工具审批请求（需弹确认窗，决策走 decideApproval）
 * @param handlers.onTraceId 服务端回显的 traceId
 */
export async function streamChat(
  message: string,
  conversationId: number,
  handlers: {
    onToken: (token: string) => void
    signal?: AbortSignal
    onTool?: (tool: ToolTrace) => void
    onRag?: (rag: RagTrace) => void
    onUsage?: (usage: UsageTrace) => void
    onReset?: () => void
    onApproval?: (approval: ApprovalRequestData) => void
    onTraceId?: (traceId: string) => void
  },
): Promise<void> {
  // 前端生成 traceId 随头上送，便于请求失败时也能与服务端日志对账
  const traceId = crypto.randomUUID()
  let res: Response
  try {
    res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-Id': traceId,
        ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
      },
      body: JSON.stringify({ message, conversationId }),
      signal: handlers.signal,
    })
  } catch (e: any) {
    // 用户主动停止（AbortController.abort()）：统一为"已停止生成"提示，不当作网络错误
    if (e?.name === 'AbortError') throw new ApiError('已停止生成', 0)
    throw new ApiError(e?.message || '网络连接失败', 0)
  }

  if (res.status === 401) {
    clearAuth()
    if (!location.pathname.startsWith('/login')) location.href = '/login'
    throw new ApiError('未登录或登录已过期', 401)
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({} as any))
    throw new ApiError(data.message || `请求失败 (${res.status})`, res.status)
  }

  // 优先采用响应头回显的 traceId（通常与上送一致），兜底用本地生成的
  handlers.onTraceId?.(res.headers.get('x-trace-id') || traceId)

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const dispatch = (eventName: string | null, data: string) => {
    if (data === '[DONE]') return
    if (eventName === 'tool') {
      try { handlers.onTool?.(JSON.parse(data)) } catch { /* 忽略坏事件 */ }
      return
    }
    if (eventName === 'rag') {
      try { handlers.onRag?.(JSON.parse(data)) } catch { /* 忽略坏事件 */ }
      return
    }
    if (eventName === 'usage') {
      try { handlers.onUsage?.(JSON.parse(data)) } catch { /* 忽略坏事件 */ }
      return
    }
    if (eventName === 'trace-reset') {
      // agent 主模型失败、备用模型重放：清空本轮已显示的 trace
      handlers.onReset?.()
      return
    }
    if (eventName === 'approval-request') {
      // 高危工具执行前的人工确认请求：弹窗，决策结果经 decideApproval 独立回传
      try {
        handlers.onApproval?.(JSON.parse(data))
      } catch {
        /* 忽略坏事件 */
      }
      return
    }
    if (eventName === null) {
      handlers.onToken(data)
    }
    // memory 等其它命名事件不到前端，忽略
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    // 统一换行，按 SSE 规范：空行分隔事件，event: 声明类型，data: 为数据行
    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')

    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)

      const dataLines: string[] = []
      let eventName: string | null = null
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).replace(/^ +/, '')
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (dataLines.length === 0) continue
      dispatch(eventName, dataLines.join('\n'))
    }
  }
}
