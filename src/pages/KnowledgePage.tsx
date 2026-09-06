import { useEffect, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Empty,
  List,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from 'antd'
import {
  CloudUploadOutlined,
  DeleteOutlined,
  FileTextOutlined,
} from '@ant-design/icons'
import type { UploadProps } from 'antd'
import {
  deleteDocument,
  listDocuments,
  uploadDocument,
  type KnowledgeDoc,
} from '../api'

/**
 * 知识库管理页
 *
 * 上传 .txt/.md 文本文档 → 后端切块并向量化存入 Agent 侧向量库；
 * 对话时 Agent 会自动检索这些文档片段（RAG），回答里可引用文档内容。
 */
export default function KnowledgePage() {
  const { message } = AntdApp.useApp()
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void loadDocs()
  }, [])

  async function loadDocs() {
    setLoading(true)
    try {
      setDocs(await listDocuments())
    } catch (err: any) {
      message.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ========== 上传文档 ==========
  const uploadProps: UploadProps = {
    accept: '.txt,.md,.text,.markdown',
    multiple: false,
    showUploadList: false,
    customRequest: async (options) => {
      const { file, onSuccess, onError } = options
      try {
        const result = await uploadDocument(file as File)
        message.success(`「${(file as File).name}」上传成功，切分为 ${result.chunks} 个片段`)
        onSuccess?.({}, new XMLHttpRequest())
        await loadDocs()
      } catch (err: any) {
        message.error(err.message)
        onError?.(err)
      }
    },
  }

  async function removeDoc(doc: KnowledgeDoc) {
    try {
      await deleteDocument(doc.id)
      message.success(`已删除「${doc.docName}」`)
      await loadDocs()
    } catch (err: any) {
      message.error(err.message)
    }
  }

  return (
    <div className="skills-page">
      <Spin spinning={loading}>
        {/* 上传文档 */}
        <Card title="上传知识文档" className="skills-panel">
          <Upload.Dragger {...uploadProps} style={{ padding: 8 }}>
            <p className="ant-upload-drag-icon">
              <CloudUploadOutlined />
            </p>
            <p className="ant-upload-text">点击或拖拽文本文件到此处上传</p>
            <p className="ant-upload-hint">
              支持 .txt / .md 文本文件；上传后自动切分、向量化，对话时可被 AI 检索引用
            </p>
          </Upload.Dragger>
        </Card>

        {/* 文档列表 */}
        <Card title={`我的知识库（${docs.length}）`} className="skills-panel">
          {docs.length === 0 ? (
            <Empty description="还没有知识文档，上传一个试试吧" />
          ) : (
            <List
              itemLayout="horizontal"
              dataSource={docs}
              renderItem={(doc) => (
                <List.Item
                  actions={[
                    <Popconfirm
                      key="del"
                      title={`确定删除文档「${doc.docName}」？`}
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => removeDoc(doc)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={<FileTextOutlined style={{ fontSize: 22 }} />}
                    title={
                      <Space size={8} wrap>
                        <Typography.Text strong>{doc.docName}</Typography.Text>
                        <Tag color="geekblue">{doc.docType}</Tag>
                        <Tag>{doc.chunkCount} 片段</Tag>
                      </Space>
                    }
                    description={
                      doc.createdAt
                        ? `上传于 ${new Date(doc.createdAt).toLocaleString('zh-CN')}`
                        : ''
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </Spin>
    </div>
  )
}