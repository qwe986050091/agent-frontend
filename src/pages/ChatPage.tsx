import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Avatar, Button, Empty, Input, Space, Spin, Tag, Tooltip, App as AntdApp } from 'antd'
import { RobotOutlined, SendOutlined, ToolOutlined, UserOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Skill {
  name: string
  shortDescription: string
  mounted: boolean
}

export default function ChatPage() {
  const { user } = useAuth()
  const { message } = AntdApp.useApp()

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [mountedSkills, setMountedSkills] = useState<Skill[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadHistory()
    loadSkills()
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  async function loadHistory() {
    try {
      const data = await api<{ messages: Message[] }>('/api/chat/history')
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

    setMessages((m) => [...m, { role: 'user', content: text }])
    setInput('')
    setLoading(true)
    try {
      const data = await api<{ answer: string }>('/api/chat', {
        method: 'POST',
        body: { message: text },
      })
      setMessages((m) => [...m, { role: 'assistant', content: data.answer }])
    } catch (err: any) {
      message.error(err.message)
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: `请求失败：${err.message}，请稍后重试。` },
      ])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="chat-page">
      {/* 已挂载技能提示条 */}
      <div className="chat-skillbar">
        <Space size={8} wrap>
          <span className="chat-skillbar-label">
            <ToolOutlined /> 已挂载技能
          </span>
          {mountedSkills.length === 0 ? (
            <span className="chat-skillbar-empty">
              暂无技能，到左侧「技能管理」挂载后可使用工具能力
            </span>
          ) : (
            mountedSkills.map((s) => (
              <Tooltip key={s.name} title={s.shortDescription}>
                <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                  {s.name}
                </Tag>
              </Tooltip>
            ))
          )}
        </Space>
      </div>

      {/* 消息区 */}
      <div className="chat-message-list" ref={listRef}>
        {historyLoading ? (
          <div className="chat-loading">
            <Spin description="加载历史消息..." />
          </div>
        ) : messages.length === 0 ? (
          <Empty
            className="chat-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                你好，{user?.nickname || user?.username} 👋
                <br />
                试试问我：「现在几点了？」或「(12 + 8) × 3 等于多少？」（需先挂载对应技能）
              </span>
            }
          />
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`chat-message ${m.role}`}>
              <Avatar
                className="chat-message-avatar"
                icon={m.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
                style={
                  m.role === 'user'
                    ? { backgroundColor: '#4f46e5' }
                    : { backgroundColor: '#e0e7ff', color: '#4338ca' }
                }
              />
              <div className="chat-message-bubble">
                <pre className="chat-message-content">{m.content}</pre>
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="chat-message assistant">
            <Avatar
              className="chat-message-avatar"
              icon={<RobotOutlined />}
              style={{ backgroundColor: '#e0e7ff', color: '#4338ca' }}
            />
            <div className="chat-message-bubble">
              <Spin size="small" /> <span className="chat-thinking">Agent 思考中...</span>
            </div>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="chat-input-area">
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，Enter 发送，Shift + Enter 换行"
          autoSize={{ minRows: 1, maxRows: 5 }}
          disabled={loading}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={send}
          loading={loading}
          disabled={!input.trim()}
        >
          发送
        </Button>
      </div>
    </div>
  )
}
