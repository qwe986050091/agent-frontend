import { useState } from 'react'
import { Avatar, Dropdown, Layout, Menu, Space, Tag, Typography } from 'antd'
import {
  AppstoreOutlined,
  LogoutOutlined,
  MessageOutlined,
  RobotOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'

const { Sider, Header, Content } = Layout

/**
 * 登录后的主框架：左侧边栏（功能导航）+ 顶部用户区 + 内容区
 */
export default function MainLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)

  const menuItems = [
    { key: '/', icon: <MessageOutlined />, label: '对话' },
    { key: '/skills', icon: <AppstoreOutlined />, label: '技能管理' },
  ]

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <Layout className="main-layout">
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="dark"
        width={210}
        className="main-sider"
      >
        <div className="sider-logo">
          <RobotOutlined className="sider-logo-icon" />
          {!collapsed && <span className="sider-logo-text">Agent 助手</span>}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>

      <Layout>
        <Header className="main-header">
          <Typography.Text strong className="header-title">
            {location.pathname === '/skills' ? '技能管理' : '智能对话'}
          </Typography.Text>
          <Space size="middle">
            <Tag color="geekblue">LangChain4j</Tag>
            <Dropdown
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
              <Space className="header-user" style={{ cursor: 'pointer' }}>
                <Avatar size="small" icon={<UserOutlined />} />
                <span>{user?.nickname || user?.username}</span>
              </Space>
            </Dropdown>
          </Space>
        </Header>

        <Content className="main-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
