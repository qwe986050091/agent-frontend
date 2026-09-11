import { useEffect, useMemo, useState } from 'react'
import { Avatar, Dropdown, Input, Modal, Popconfirm, App as AntdApp } from 'antd'
import {
  AppstoreOutlined,
  BarChartOutlined,
  BookOutlined,
  DeleteOutlined,
  EditOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth'
import {
  listConversations,
  createConversation,
  renameConversation,
  deleteConversation,
  type Conversation,
} from '../api'
import DeskPet from '../components/DeskPet'
import appIcon from '../assets/app-icon.jpg'

const NAV_ITEMS = [
  { key: '/knowledge', icon: <BookOutlined />, label: '知识库' },
  { key: '/skills', icon: <AppstoreOutlined />, label: '技能管理' },
  { key: '/usage', icon: <BarChartOutlined />, label: '用量统计' },
]

/**
 * 固定在侧边栏顶部、不随滚动消失的入口（ChatGPT 风格）。
 * action='navigate' 跳转 key 路由；action='new-chat' 点击即新建会话（动作型，不高亮）。
 * 以后要加固定项（如"图片生成"），往这里加一条即可，渲染逻辑无需改动。
 */
const FIXED_ITEMS: Array<{
  key: string
  icon: ReactNode
  label: string
  action: 'navigate' | 'new-chat'
}> = [
  { key: 'new-chat', icon: <EditOutlined />, label: '新聊天', action: 'new-chat' },
]

/** 随「最近」列表一起滚动的普通路由 tab */
const SCROLL_NAV = NAV_ITEMS

/**
 * 登录后的主框架：浅色极简侧边栏 + 内容区（ChatGPT 风格）
 *
 * 会话列表挂在侧边栏导航下方（仅 /chat 路由显示），与 ChatGPT 一致：
 * 记录多时列表区自动滚动；当前会话通过 URL query（?conversationId=N）传递，
 * 刷新不丢失，ChatPage 只负责渲染对话区。
 */
export default function MainLayout() {
  const { user, logout } = useAuth()
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const displayName = user?.nickname || user?.username || '用户'

  /** 当前激活会话 id（来自 URL query），缺省 0（默认/历史会话） */
  const activeConversationId = useMemo(() => {
    const raw = new URLSearchParams(location.search).get('conversationId')
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : 0
  }, [location.search])

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  /** 进入主框架即加载会话列表（所有页面侧边栏常驻显示）；无会话自动新建一个 */
  useEffect(() => {
    loadConversations()
  }, [])

  async function loadConversations() {
    try {
      const list = await listConversations()
      if (list.length === 0) {
        const created = await createConversation('新对话')
        setConversations([created])
        navigate(`/chat?conversationId=${created.id}`, { replace: true })
      } else {
        setConversations(list)
        if (!activeConversationId) {
          navigate(`/chat?conversationId=${list[0].id}`, { replace: true })
        }
      }
    } catch (err: any) {
      message.error(err.message)
    }
  }

  /** 切换会话：URL 变化 → ChatPage 感知后重新加载历史 */
  function switchConversation(id: number) {
    navigate(`/chat?conversationId=${id}`)
  }

  /** 新建会话 */
  async function handleCreate() {
    try {
      const created = await createConversation('新对话')
      setConversations((list) => [created, ...list])
      navigate(`/chat?conversationId=${created.id}`)
    } catch (err: any) {
      message.error(err.message)
    }
  }

  /** 提交重命名 */
  async function handleRename() {
    const title = renameValue.trim()
    if (!renameTarget || !title) return
    try {
      const updated = await renameConversation(renameTarget.id, title)
      setConversations((list) => list.map((c) => (c.id === updated.id ? updated : c)))
      setRenameTarget(null)
    } catch (err: any) {
      message.error(err.message)
    }
  }

  /** 删除会话：级联删除消息；若删的是当前会话则切到剩余第一个 */
  async function handleDelete(conv: Conversation) {
    try {
      await deleteConversation(conv.id)
      setConversations((list) => {
        const rest = list.filter((c) => c.id !== conv.id)
        if (conv.id === activeConversationId) {
          navigate(rest.length > 0 ? `/chat?conversationId=${rest[0].id}` : '/chat')
        }
        return rest
      })
    } catch (err: any) {
      message.error(err.message)
    }
  }

  return (
    <div className="app-shell">
      {/* ============ 左侧边栏 ============ */}
      <aside className={`app-sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="app-sidebar-inner">
          {/* 固定顶部（不随滚动消失）：品牌（点击回首页）+ 新聊天 */}
          <div className="sidebar-top">
            <div className="sidebar-header">
              <button
                type="button"
                className="sidebar-brand sidebar-brand-btn"
                title="首页"
                onClick={() => navigate('/')}
              >
                <img className="sidebar-brand-dot" src={appIcon} alt="" />
                Agent 助手
              </button>
              <button
                type="button"
                className="sidebar-icon-btn"
                title="收起侧边栏"
                onClick={() => setCollapsed(true)}
              >
                <MenuFoldOutlined />
              </button>
            </div>

            <nav className="sidebar-nav">
              {FIXED_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`sidebar-nav-item${
                    item.action === 'navigate' && location.pathname === item.key ? ' active' : ''
                  }`}
                  onClick={() => {
                    if (item.action === 'new-chat') {
                      void handleCreate()
                    } else {
                      navigate(item.key)
                    }
                  }}
                >
                  <span className="sidebar-nav-icon">{item.icon}</span>
                  <span className="sidebar-nav-label">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>

          {/* 单一滚动区：知识库/技能管理 tab +「最近」标题 + 会话列表（一起滚动，一条滚动条） */}
          <div className="sidebar-scroll">
            <nav className="sidebar-nav sidebar-nav--scroll">
              {SCROLL_NAV.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`sidebar-nav-item ${location.pathname === item.key ? 'active' : ''}`}
                  onClick={() => navigate(item.key)}
                >
                  <span className="sidebar-nav-icon">{item.icon}</span>
                  <span className="sidebar-nav-label">{item.label}</span>
                </button>
              ))}
            </nav>

            <div className="sidebar-recent-label">最近</div>
            <div className="sidebar-convs-list">
              {conversations.map((c) => (
                <div
                  key={c.id}
                  className={`sidebar-conv-item${c.id === activeConversationId ? ' active' : ''}`}
                  onClick={() => switchConversation(c.id)}
                  title={c.title}
                >
                  <span className="sidebar-conv-title">{c.title}</span>
                  <span className="sidebar-conv-ops" onClick={(e) => e.stopPropagation()}>
                    <EditOutlined onClick={() => { setRenameTarget(c); setRenameValue(c.title) }} />
                    <Popconfirm
                      title="删除该会话及其全部消息？"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => handleDelete(c)}
                    >
                      <DeleteOutlined />
                    </Popconfirm>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 固定底部：用户区 */}
          <div className="sidebar-footer">
            <Dropdown
              trigger={['click']}
              placement="topLeft"
              menu={{
                items: [
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: '退出登录',
                    onClick: handleLogout,
                  },
                ],
              }}
            >
              <div className="sidebar-user">
                <Avatar
                  size={32}
                  icon={<UserOutlined />}
                  className="sidebar-user-avatar"
                  style={{ backgroundColor: '#dbe6ff', color: '#3b6fd4' }}
                />
                <div className="sidebar-user-meta">
                  <span className="sidebar-user-name">{displayName}</span>
                  <span className="sidebar-user-sub">
                    {user?.nickname ? `@${user.username}` : '已登录'}
                  </span>
                </div>
              </div>
            </Dropdown>
          </div>
        </div>
      </aside>

      {/* ============ 主内容区 ============ */}
      <main className="app-main">
        {collapsed && (
          <button
            type="button"
            className="sidebar-expand-btn"
            title="展开侧边栏"
            onClick={() => setCollapsed(false)}
          >
            <MenuUnfoldOutlined />
          </button>
        )}
        <Outlet />
      </main>

      {/* 桌宠小助手：全局悬浮，支持拖拽 / 跟随 / 打盹 */}
      <DeskPet />

      {/* 重命名会话弹窗 */}
      <Modal
        title="重命名会话"
        open={!!renameTarget}
        onOk={handleRename}
        onCancel={() => setRenameTarget(null)}
        okText="保存"
        cancelText="取消"
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={handleRename}
          maxLength={200}
          placeholder="会话标题"
        />
      </Modal>
    </div>
  )
}
