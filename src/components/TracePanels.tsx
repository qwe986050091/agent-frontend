import { App, Collapse, Tooltip } from 'antd'
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
 * 实时流与历史 trace 懒加载共用同一渲染。
 */
export function TracePanels({
  tools,
  recalls,
}: {
  tools?: ToolTrace[]
  recalls?: RagTrace[]
}) {
  const toolList = tools || []
  const recallList = recalls || []
  if (toolList.length === 0 && recallList.length === 0) return null

  const segmentCount = recallList.reduce((n, r) => n + (r.segments?.length || 0), 0)

  const items = []
  if (recallList.length > 0) {
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
            (rag.segments || []).map((seg, si) => (
              <div className="trace-segment" key={`${gi}-${si}`}>
                <div className="trace-segment-head">
                  <span className="trace-segment-source">
                    {seg.type === 'conversation' ? '历史对话' : seg.source || '未知来源'}
                  </span>
                  <span className="trace-segment-score">相似度 {Math.round(seg.score * 100)}%</span>
                </div>
                <div className="trace-segment-text">{seg.text}</div>
              </div>
            )),
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

  return <Collapse ghost size="small" className="chat-trace-collapse" items={items} />
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
