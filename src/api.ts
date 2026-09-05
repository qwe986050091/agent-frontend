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
