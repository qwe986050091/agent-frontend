import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Input, Spin, Tooltip, App as AntdApp } from 'antd'
import {
  ArrowUpOutlined,
  StopOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { api, streamChat } from '../api'
import { useAuth } from '../auth'
import assistantAvatar from '../assets/assistant-avatar.jpg'

const { TextArea } = Input

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Skill {
  name: string
  shortDescription: string
  mounted: boolean
}

/** 根据当前时间生成问候语 */
function greetingOf(): string {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export default function ChatPage() {
  const { user } = useAuth()
  const { message } = AntdApp.useApp()
  const [searchParams] = useSearchParams()

  // 当前会话 id 由 MainLayout 侧边栏通过 URL query 传入；缺省 0（默认/历史会话）
  const activeConversationId = Number(searchParams.get('conversationId') || 0)

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [mountedSkills, setMountedSkills] = useState<Skill[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  // 当前流式请求的 AbortController：点"停止"时 abort，前端断开 → 后端/agent 逐级取消生成
  const abortRef = useRef<AbortController | null>(null)

  // 进入页面 / 切换会话时加载对应历史
  useEffect(() => {
    loadHistory(activeConversationId)
  }, [activeConversationId])

  useEffect(() => {
    loadSkills()
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  async function loadHistory(conversationId: number) {
    setMessages([])
    setHistoryLoading(true)
    try {
      const data = await api<{ messages: Message[] }>(`/api/chat/history?conversationId=${conversationId}`)
      setMessages(data.messages || [])
    } catch (err: any) {
      message.error(err.message)
    } finally {
      setHistoryLoading(false)
    }
  }

  async function loadSkills() {
    try {
      const data = await api<{ skills: Skill[] }>('/api/skills')
      setMountedSkills((data.skills || []).filter((s) => s.mounted))
    } catch {
      // 技能加载失败不阻塞对话
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || loading) return

    // 用户消息 + 占位的空 AI 消息（token 逐段追加进去）
    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setInput('')
    setLoading(true)

    const controller = new AbortController()
    abortRef.current = controller
    try {
      await streamChat(text, activeConversationId, {
        signal: controller.signal,
        onToken: (token) =>
          setMessages((m) => {
            const copy = [...m]
            const last = copy[copy.length - 1]
            if (last && last.role === 'assistant') {
              copy[copy.length - 1] = { ...last, content: last.content + token }
            }
            return copy
          }),
      })
    } catch (err: any) {
      // 用户主动停止：保留已生成内容，不弹错误
      if (err?.status === 0 && err?.message === '已停止生成') return
      message.error(err.message)
      setMessages((m) => {
        const copy = [...m]
        const last = copy[copy.length - 1]
        if (last && last.role === 'assistant') {
          copy[copy.length - 1] = {
            ...last,
            content: last.content || `请求失败：${err.message}，请稍后重试。`,
          }
        }
        return copy
      })
    } finally {
      abortRef.current = null
      setLoading(false)
    }
  }

  /** 停止当前生成：abort 前端 fetch → 后端/agent 逐级断开并取消 LLM 生成 */
  function stop() {
    abortRef.current?.abort()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const displayName = user?.nickname || user?.username || '朋友'
  const isEmpty = !historyLoading && messages.length === 0

  // ============ 胶囊输入框（空态 / 对话态共用） ============
  const composer = (
    <div className="chat-composer-wrap">
      {mountedSkills.length > 0 && (
        <div className="chat-skills">
          <span className="chat-skills-label">
            <ToolOutlined /> 已挂载技能
          </span>
          {mountedSkills.map((s) => (
            <Tooltip key={s.name} title={s.shortDescription}>
              <span className="chat-skill-chip">{s.name}</span>
            </Tooltip>
          ))}
        </div>
      )}

      <div className="chat-composer">
        <TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="有问题，随便问"
          variant="borderless"
          autoSize={{ minRows: 1, maxRows: 6 }}
          disabled={loading}
        />
        <button
          type="button"
          className="chat-send-btn"
          aria-label={loading ? '停止生成' : '发送'}
          onClick={loading ? stop : send}
          disabled={!input.trim() && !loading}
        >
          {loading ? <StopOutlined /> : <ArrowUpOutlined />}
        </button>
      </div>

      <p className="chat-hint">
        Enter 发送，Shift + Enter 换行
        {mountedSkills.length === 0 ? ' · 可在「技能管理」中挂载工具技能' : ''}
      </p>
    </div>
  )

  // ============ 空态：居中问候 + 输入框 ============
  if (historyLoading) {
    return (
      <div className="chat-page">
        <div className="chat-loading">
          <Spin />
          <span>加载会话历史...</span>
        </div>
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="chat-page chat-page--welcome">
        <div className="chat-welcome">
          <div className="chat-welcome-hero">
            <img src={assistantAvatar} alt="AI 助手" />
          </div>
          <h1 className="chat-greeting">
            {greetingOf()}，{displayName}
          </h1>
          <p className="chat-welcome-sub">温柔而高效地和你对话，写东西、查资料都可以交给我</p>
          {composer}
        </div>
      </div>
    )
  }

  // ============ 对话态：消息流 + 底部输入框 ============
  return (
    <div className="chat-page">
      <div className="chat-message-list" ref={listRef}>
        <div className="chat-thread">
          {messages.map((m, i) => {
            const streaming = loading && i === messages.length - 1 && m.role === 'assistant'
            if (m.role === 'user') {
              return (
                <div key={i} className="chat-row user">
                  <div className="chat-bubble-user">
                    <pre className="chat-text">{m.content}</pre>
                  </div>
                </div>
              )
            }
            return (
              <div key={i} className="chat-row assistant">
                <img className="chat-avatar" src={assistantAvatar} alt="助手" />
                {streaming && !m.content ? (
                  <span className="chat-thinking">
                    <Spin size="small" /> 思考中...
                  </span>
                ) : (
                  <div className="chat-bubble-assistant">
                    <pre className="chat-text">
                      {m.content}
                      {streaming ? <span className="chat-cursor" /> : null}
                    </pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {composer}
    </div>
  )
}
