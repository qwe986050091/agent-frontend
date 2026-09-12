import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { App as AntdApp, Checkbox, Input, Modal, Space, Spin, Tag, Tooltip } from 'antd'
import {
  ArrowUpOutlined,
  StopOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  api,
  createConversation,
  decideApproval,
  streamChat,
  type ApprovalRequestData,
  type RagTrace,
  type ToolTrace,
  type UsageTrace,
} from '../api'
import { useAuth } from '../auth'
import { useConversations } from '../layouts/MainLayout'
import { TracePanels, TraceFooter } from '../components/TracePanels'
import HistoricalTrace from '../components/HistoricalTrace'
import assistantAvatar from '../assets/assistant-avatar.jpg'

const { TextArea } = Input

interface Message {
  role: 'user' | 'assistant'
  content: string
  /** 全链路 traceId（历史消息由 history 接口返回；实时流由响应头返回） */
  traceId?: string
  tools?: ToolTrace[]
  recalls?: RagTrace[]
  usage?: UsageTrace & { costYuan?: number }
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

/** 用首条消息生成会话标题：折叠空白，超长截断（ChatGPT 风格；后端标题上限 200 字） */
function titleFromMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine
}

export default function ChatPage() {
  const { user } = useAuth()
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { addConversation } = useConversations()

  // 会话 id 由 MainLayout 侧边栏通过 URL query 传入：
  // 无参数 = 草稿新会话（null，尚未落库）；0 = 默认/历史会话；N > 0 = 真实会话
  const convParam = searchParams.get('conversationId')
  const parsedConvId = convParam === null ? null : Number(convParam)
  const activeConversationId =
    parsedConvId !== null && Number.isFinite(parsedConvId) && parsedConvId >= 0 ? parsedConvId : null

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(activeConversationId !== null)
  const [mountedSkills, setMountedSkills] = useState<Skill[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  // 当前流式请求的 AbortController：点"停止"时 abort，前端断开 → 后端/agent 逐级取消生成
  const abortRef = useRef<AbortController | null>(null)
  // 草稿态首条消息刚建会话并 replace 到新 id 时，跳过一次历史重载（乐观气泡已在屏上）
  const skipHistoryLoadRef = useRef<number | null>(null)

  // 高危工具审批：SSE 推来的审批请求排队，单弹窗依次处理
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequestData[]>([])
  const [approvalDeciding, setApprovalDeciding] = useState(false)
  const [rememberGrant, setRememberGrant] = useState(false)
  const currentApproval = approvalQueue[0]

  // 进入页面 / 切换会话时加载对应历史；草稿态直接是空白欢迎页，不请求历史
  useEffect(() => {
    if (activeConversationId === null) {
      setMessages([])
      setHistoryLoading(false)
      return
    }
    if (skipHistoryLoadRef.current === activeConversationId) {
      skipHistoryLoadRef.current = null
      setHistoryLoading(false)
      return
    }
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

    let conversationId = activeConversationId

    // 草稿态：点击"新聊天"时未写库，直到首条消息真正发出才创建会话
    if (conversationId === null) {
      setLoading(true)
      try {
        const created = await createConversation(titleFromMessage(text))
        conversationId = created.id
        // 侧边栏即时置顶出现新会话；replace 换 URL（刷新/中断后仍在该会话）
        addConversation(created)
        skipHistoryLoadRef.current = created.id
        navigate(`/chat?conversationId=${created.id}`, { replace: true })
      } catch (err: any) {
        message.error(err.message)
        setLoading(false)
        return
      }
    }

    // 用户消息 + 占位的空 AI 消息（token 逐段追加进去）
    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setInput('')
    setLoading(true)

    const controller = new AbortController()
    abortRef.current = controller

    /** 不可变更新最后一条助手消息 */
    const patchLast = (patch: Partial<Message>) =>
      setMessages((m) => {
        const copy = [...m]
        const last = copy[copy.length - 1]
        if (last && last.role === 'assistant') {
          copy[copy.length - 1] = { ...last, ...patch }
        }
        return copy
      })

    try {
      await streamChat(text, conversationId, {
        signal: controller.signal,
        onTraceId: (id) => patchLast({ traceId: id }),
        onToken: (token) =>
          setMessages((m) => {
            const copy = [...m]
            const last = copy[copy.length - 1]
            if (last && last.role === 'assistant') {
              copy[copy.length - 1] = { ...last, content: last.content + token }
            }
            return copy
          }),
        onTool: (tool) =>
          setMessages((m) => {
            const copy = [...m]
            const last = copy[copy.length - 1]
            if (last && last.role === 'assistant') {
              copy[copy.length - 1] = { ...last, tools: [...(last.tools || []), tool] }
            }
            return copy
          }),
        onRag: (rag) =>
          setMessages((m) => {
            const copy = [...m]
            const last = copy[copy.length - 1]
            if (last && last.role === 'assistant') {
              copy[copy.length - 1] = { ...last, recalls: [...(last.recalls || []), rag] }
            }
            return copy
          }),
        onUsage: (usage) => patchLast({ usage }),
        onReset: () => patchLast({ tools: [], recalls: [], usage: undefined }),
        onApproval: (approval) =>
          setApprovalQueue((q) => [...q, approval]),
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
      // 流结束清理未决审批（断连/取消时 agent 侧会自动拒绝）
      setApprovalQueue([])
      setRememberGrant(false)
      setApprovalDeciding(false)
    }
  }

  /** 提交高危工具审批决策：拒绝/允许（可选「本次会话始终允许」） */
  async function decideCurrentApproval(approved: boolean) {
    const approval = currentApproval
    if (!approval || approvalDeciding) return
    setApprovalDeciding(true)
    try {
      await decideApproval(approval.approvalId, approved, approved && rememberGrant)
    } catch (err: any) {
      message.error(`审批提交失败：${err.message}（服务端将按超时自动拒绝）`)
    } finally {
      setApprovalDeciding(false)
      setRememberGrant(false)
      setApprovalQueue((q) => q.slice(1))
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

  // ============ 高危工具审批弹窗（SSE 推来请求，决策走独立接口） ============
  const riskLevel = currentApproval?.riskLevel
  const riskColor = riskLevel === 'high' ? 'red' : riskLevel === 'medium' ? 'orange' : 'blue'
  const riskText = riskLevel === 'high' ? '高危' : riskLevel === 'medium' ? '中危' : '低危'
  const approvalModal = (
    <Modal
      open={!!currentApproval}
      title={
        <Space>
          <WarningOutlined style={{ color: '#d4380d' }} />
          {currentApproval?.title || '高危操作确认'}
        </Space>
      }
      okText="允许执行"
      cancelText="拒绝"
      confirmLoading={approvalDeciding}
      cancelButtonProps={{ disabled: approvalDeciding }}
      maskClosable={false}
      keyboard={false}
      width={560}
      okButtonProps={{ danger: riskLevel === 'high' }}
      onOk={() => void decideCurrentApproval(true)}
      onCancel={() => void decideCurrentApproval(false)}
    >
      {currentApproval && (
        <div className="approval-body">
          <p className="approval-desc">
            AI 助手即将执行外部操作，请核对以下工具与参数；拒绝后该操作不会执行。
          </p>
          <Space size={8} wrap style={{ marginBottom: 10 }}>
            <Tag color={riskColor}>{riskText}</Tag>
            <code className="approval-tool">{currentApproval.tool}</code>
          </Space>
          <pre className="approval-args">{currentApproval.argsPreview || '（无参数）'}</pre>
          <Checkbox
            checked={rememberGrant}
            onChange={(e) => setRememberGrant(e.target.checked)}
          >
            本次会话始终允许此工具（同一会话后续调用不再询问）
          </Checkbox>
        </div>
      )}
    </Modal>
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
        {approvalModal}
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
            const hasLiveTrace = (m.tools?.length || 0) > 0 || (m.recalls?.length || 0) > 0
            return (
              <div key={i} className="chat-row assistant">
                <img className="chat-avatar" src={assistantAvatar} alt="助手" />
                {streaming && !m.content && !hasLiveTrace ? (
                  <span className="chat-thinking">
                    <Spin size="small" /> 思考中...
                  </span>
                ) : (
                  <div className="chat-bubble-assistant">
                    <TracePanels tools={m.tools} recalls={m.recalls} />
                    {m.content && (
                      <pre className="chat-text">
                        {m.content}
                        {streaming ? <span className="chat-cursor" /> : null}
                      </pre>
                    )}
                    {/* 实时 trace 已在上方渲染；历史消息（无实时数据但有 traceId）懒加载回看 */}
                    {!streaming && !hasLiveTrace && m.traceId && (
                      <HistoricalTrace traceId={m.traceId} />
                    )}
                    {(hasLiveTrace || m.usage) && <TraceFooter usage={m.usage} traceId={m.traceId} />}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {composer}
      {approvalModal}
    </div>
  )
}
