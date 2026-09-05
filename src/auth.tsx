import { createContext, useContext, useState, type ReactNode } from 'react'
import { api, clearAuth, getStoredUser, saveAuth, type AuthUser } from './api'

interface AuthContextValue {
  user: AuthUser | null
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, nickname: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>(null as unknown as AuthContextValue)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())

  async function login(username: string, password: string) {
    const data = await api<{ token: string; username: string; nickname: string }>(
      '/api/auth/login',
      { method: 'POST', body: { username, password } },
    )
    const u = { username: data.username, nickname: data.nickname }
    saveAuth(data.token, u)
    setUser(u)
  }

  async function register(username: string, password: string, nickname: string) {
    const data = await api<{ token: string; username: string; nickname: string }>(
      '/api/auth/register',
      { method: 'POST', body: { username, password, nickname } },
    )
    const u = { username: data.username, nickname: data.nickname }
    saveAuth(data.token, u)
    setUser(u)
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      // 忽略登出请求失败，本地一定清理
    }
    clearAuth()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
