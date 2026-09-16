import { useEffect, useState } from 'react'
import { App, Collapse, Tag, Tooltip } from 'antd'
import {
  BookOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CopyOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import type { RagTrace, ToolTrace, UsageTrace } from '../api'

/** 工具参数 JSON 紧凑展示（{"a":12.0,"b":8.0} → a=12, b=8 风格，超长截断） */
function compactArgs(raw?: string): string {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(obj)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')
  } catch {
    return raw
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Agent「思考过程」折叠面板：知识召回 + 工具调用。
 * 实时流与历史 trace 懒加载共用同一渲染；回答中的 [n] 点击可展开并定位到对应文档片段。
 */
/** 引用点击信号（ChatPage 在点回答中的 [n] 时下发） */
export interface CiteSignal {
  /** 文档序号（从 1 起，与回答里的 [n] 一致） */
  n: number
  /** 时间戳：重复点同一个编号也能重新触发高亮/展开 */
  ts: number
}

export function TracePanels({
  tools,
  recalls,
  citeSignal,
}: {
  tools?: ToolTrace[]
  recalls?: RagTrace[]
  citeSignal?: CiteSignal | null
}) {
  const toolList = tools || []
  const recallList = recalls || []
  const [activeKeys, setActiveKeys] = useState<string[]>([])
  const [flashNo, setFlashNo] = useState<number | null>(null)

  // 点回答中的 [n]：展开面板 → 滚动并高亮第 n 个文档片段
  useEffect(() => {
    if (!citeSignal) return
    setActiveKeys((keys) => (keys.includes('rag') ? keys : [...keys, 'rag']))
    const timer = setTimeout(() => {
      document
        .getElementById(`trace-cite-${citeSignal.n}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFlashNo(citeSignal.n)
      setTimeout(() => setFlashNo((cur) => (cur === citeSignal.n ? null : cur)), 1800)
    }, 120)
    return () => clearTimeout(timer)
  }, [citeSignal])

  if (toolList.length === 0 && recallList.length === 0) return null

  const segmentCount = recallList.reduce((n, r) => n + (r.segments?.length || 0), 0)

  const items = []
  if (recallList.length > 0) {
    let docNo = 0
    items.push({
      key: 'rag',
      label: (
        <span className="trace-panel-label">
          <BookOutlined /> 知识召回
          <span className="trace-count">{segmentCount}</span>
        </span>
      ),
      children: (
        <div className="trace-segments">
          {segmentCount === 0 && <div className="trace-segment-empty">本次检索未命中知识库片段</div>}
          {recallList.map((rag, gi) =>
            (rag.segments || []).map((seg, si) => {
              const isDoc = seg.type !== 'conversation'
              if (isDoc) docNo += 1
              const flash = isDoc && flashNo === docNo
              return (
                <div
                  className={`trace-segment${flash ? ' trace-segment--flash' : ''}`}
                  key={`${gi}-${si}`}
                  id={isDoc ? `trace-cite-${docNo}` : undefined}
                >
                  <div className="trace-segment-head">
                    <span className="trace-segment-source">
                      {isDoc ? (
                        <span className="trace-segment-no">[{docNo}]</span>
                      ) : null}
                      {isDoc ? seg.source || '未知来源' : '历史对话'}
                    </span>
                    <span className="trace-segment-score">
                      {seg.channel && seg.channel !== 'vector' && (
                        <Tag
                          color={seg.channel === 'keyword' ? 'orange' : 'purple'}
                          style={{ marginInlineEnd: 6 }}
                        >
                          {seg.channel === 'keyword' ? '关键词命中' : '语义+关键词'}
                        </Tag>
                      )}
                      {seg.rerankScore != null && (
                        <span style={{ marginInlineEnd: 8 }}>精排 {seg.rerankScore.toFixed(2)}</span>
                      )}
                      相似度 {Math.round(seg.score * 100)}%
                    </span>
                  </div>
                  <div className="trace-segment-text">{seg.text}</div>
                </div>
              )
            }),
          )}
        </div>
      ),
    })
  }

  if (toolList.length > 0) {
    items.push({
      key: 'tool',
      label: (
        <span className="trace-panel-label">
          <ToolOutlined /> 工具调用
          <span className="trace-count">{toolList.length}</span>
        </span>
      ),
      children: (
        <div className="trace-tools">
          {toolList.map((t, i) => (
            <div className={`trace-tool ${t.success ? '' : 'trace-tool--fail'}`} key={`${t.name}-${i}`}>
              <div className="trace-tool-head">
                {t.success ? (
                  <CheckCircleFilled className="trace-tool-icon trace-tool-icon--ok" />
                ) : (
                  <CloseCircleFilled className="trace-tool-icon trace-tool-icon--fail" />
                )}
                <span className="trace-tool-name">{t.name}</span>
                <span className="trace-tool-args">{truncate(compactArgs(t.arguments), 48)}</span>
                <span className="trace-tool-duration">{t.durationMs}ms</span>
              </div>
              {(t.result || t.error) && (
                <pre className="trace-tool-result">
                  {t.success ? truncate(t.result || '', 300) : truncate(t.error || '', 300)}
                </pre>
              )}
            </div>
          ))}
        </div>
      ),
    })
  }

  return (
    <Collapse
      ghost
      size="small"
      className="chat-trace-collapse"
      items={items}
      activeKey={activeKeys}
      onChange={(keys) => setActiveKeys(Array.isArray(keys) ? (keys as string[]) : [String(keys)])}
    />
  )
}

/** 气泡底栏：token 用量/费用 + 可复制 traceId */
export function TraceFooter({ usage, traceId }: { usage?: UsageTrace | null; traceId?: string | null }) {
  const { message } = App.useApp()
  if (!usage && !traceId) return null

  const copyTraceId = () => {
    if (!traceId) return
    const done = () => message.success('traceId 已复制')
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(traceId).then(done).catch(() => message.warning('复制失败，请手动选择'))
    } else {
      message.warning('浏览器不支持自动复制')
    }
  }

  return (
    <div className="chat-trace-footer">
      {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) && (
        <span className="chat-trace-usage">
          <ThunderboltOutlined /> 输入 {usage.inputTokens} · 输出 {usage.outputTokens}
          {usage.fallback && <span className="chat-trace-fallback">备用模型</span>}
          {usage.cancelled ? (
            <span className="chat-trace-cancelled">已停止</span>
          ) : (
            <span className="chat-trace-cost">¥{Number(usage.costYuan ?? 0).toFixed(4)}</span>
          )}
        </span>
      )}
      {traceId && (
        <Tooltip title="点击复制全链路 traceId">
          <span className="chat-trace-id" onClick={copyTraceId}>
            <CopyOutlined /> {traceId.length > 13 ? traceId.slice(0, 8) + '…' : traceId}
          </span>
        </Tooltip>
      )}
    </div>
  )
}
