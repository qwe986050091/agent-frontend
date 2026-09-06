import { useState } from 'react'
import { Avatar, Dropdown } from 'antd'
import {
  AppstoreOutlined,
  BookOutlined,
  EditOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'

const NAV_ITEMS = [
  { key: '/', icon: <EditOutlined />, label: '新聊天' },
  { key: '/knowledge', icon: <BookOutlined />, label: '知识库' },
  { key: '/skills', icon: <AppstoreOutlined />, label: '技能管理' },
]

/**
 * 登录后的主框架：浅色极简侧边栏 + 内容区（ChatGPT 风格）
 */
export default function MainLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)

  const displayName = user?.nickname || user?.username || '用户'

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <div className="app-shell">
      {/* ============ 左侧边栏 ============ */}
      <aside className={`app-sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="app-sidebar-inner">
          <div className="sidebar-header">
            <span className="sidebar-brand">Agent 助手</span>
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
            {NAV_ITEMS.map((item) => (
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

          <div className="sidebar-spacer" />

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
    </div>
  )
}
