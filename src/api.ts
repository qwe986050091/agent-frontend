// 简单的 fetch 封装：自动携带登录 token，统一错误处理

const TOKEN_KEY = 'agent_token'
const USER_KEY = 'agent_user'

export interface AuthUser {
  username: string
  nickname: string
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

/**
 * 流式对话（SSE）：POST /api/chat/stream
 *
 * 服务端逐 token 推送 text/event-stream，这里用 fetch + ReadableStream
 * 手动解析 SSE（EventSource 不支持 POST 和自定义请求头）。
 *
 * @param onToken 每收到一个 token 片段回调
 * @param signal  AbortSignal，用于中断生成
 */
export async function streamChat(
  message: string,
  conversationId: number,
  handlers: { onToken: (token: string) => void; signal?: AbortSignal },
): Promise<void> {
  let res: Response
  try {
    res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    // 统一换行，按 SSE 规范：空行分隔事件，data: 开头为数据行
    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')

    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)

      const dataLines: string[] = []
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (dataLines.length === 0) continue

      const data = dataLines.join('\n')
      if (data === '[DONE]') return
      handlers.onToken(data)
    }
  }
}
