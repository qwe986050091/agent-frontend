import { useCallback, useEffect, useRef, useState } from 'react'
import petMascot from '../assets/pet-mascot.jpg'

const W = 118
const IDLE_MS = 20000

const LINES = [
  '嗨～今天也要元气满满哦！',
  '有什么想问的，尽管戳我啦～',
  '啦啦啦～我就在这儿陪着你',
  '写累了？喝口水再继续嘛',
  '双击我可以开关「跟随鼠标」哦',
  '按住拖一拖，把我放到喜欢的位置',
  '知识库和技能都备好啦，随时开工！',
  '嘿嘿，被你发现啦',
  '今天的你也超厉害的！',
]
const PAT_LINES = ['嘿嘿，摸摸头好舒服～', '再多摸一下嘛', '开心！给你比个心', '哇，被宠爱了呢', '最喜欢和你待在一起啦']
const WAKE_LINES = ['唔…我刚刚打了个小盹儿', '你回来啦！我还以为你走丢了呢', '呼…睡饱啦，继续加油！', '啊呜…被你叫醒啦～']

const HEART = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
  </svg>
)
const STAR = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2l1.9 6.3L20 10l-6.1 1.7L12 18l-1.9-6.3L4 10l6.1-1.7z" />
  </svg>
)

interface Spark {
  id: number
  left: number
  top: number
  heart: boolean
  delay: number
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 桌宠小助手：Q 版坐姿形象
 * - 单击：摸摸头（蹦跳 + 爱心星星 + 撒娇台词）
 * - 双击：切换「跟随鼠标 / 停靠」
 * - 拖拽：移动到任意位置
 * - 静置 20s：打盹冒 Zzz，交互即唤醒
 */
export default function DeskPet() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [bubble, setBubble] = useState<{ show: boolean; text: string }>({ show: false, text: '' })
  const [follow, setFollow] = useState(true)
  const [idle, setIdle] = useState(false)
  const [patting, setPatting] = useState(false)
  const [sparks, setSparks] = useState<Spark[]>([])
  const [dragging, setDragging] = useState(false)

  const posRef = useRef({ x: 0, y: 0 })
  const mouseRef = useRef({ x: 0, y: 0 })
  const followRef = useRef(true)
  const draggingRef = useRef(false)
  const movedRef = useRef(0)
  const startRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 })
  const lastActiveRef = useRef(Date.now())
  const bubbleTimer = useRef<ReturnType<typeof setTimeout>>()
  const sparkId = useRef(0)

  const clamp = useCallback((v: number, min: number, max: number) => Math.max(min, Math.min(max, v)), [])

  const petH = useCallback(() => rootRef.current?.offsetHeight || 280, [])

  const applyPos = useCallback(() => {
    const el = rootRef.current
    if (el) {
      el.style.left = `${posRef.current.x}px`
      el.style.top = `${posRef.current.y}px`
    }
  }, [])

  const showBubble = useCallback((text: string, hold = 4200) => {
    setBubble({ show: true, text })
    clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => setBubble((b) => ({ ...b, show: false })), hold)
  }, [])

  const spawnSparkles = useCallback(() => {
    const batch: Spark[] = Array.from({ length: 4 }, (_, i) => ({
      id: ++sparkId.current,
      left: 26 + Math.random() * 62,
      top: 14 + Math.random() * 30,
      heart: i % 2 === 0,
      delay: Math.random() * 0.12,
    }))
    setSparks((s) => [...s, ...batch])
    const ids = new Set(batch.map((b) => b.id))
    setTimeout(() => setSparks((s) => s.filter((x) => !ids.has(x.id))), 1100)
  }, [])

  const pat = useCallback(
    (wasIdle: boolean) => {
      lastActiveRef.current = Date.now()
      setIdle(false)
      spawnSparkles()
      setPatting(true)
      setTimeout(() => setPatting(false), 620)
      showBubble(wasIdle ? pick(WAKE_LINES) : Math.random() < 0.55 ? pick(PAT_LINES) : pick(LINES))
    },
    [showBubble, spawnSparkles],
  )

  // 初始化位置 + 全局监听 + 动画循环
  useEffect(() => {
    posRef.current = { x: window.innerWidth - W - 26, y: window.innerHeight - petH() - 14 }
    mouseRef.current = { x: posRef.current.x, y: posRef.current.y }
    applyPos()

    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY }
      lastActiveRef.current = Date.now()
    }
    const onKeyDown = () => {
      lastActiveRef.current = Date.now()
    }
    const onResize = () => {
      posRef.current.x = clamp(posRef.current.x, 8, window.innerWidth - W - 8)
      posRef.current.y = clamp(posRef.current.y, 8, window.innerHeight - petH() - 8)
      applyPos()
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    window.addEventListener('keydown', onKeyDown, { passive: true })
    window.addEventListener('resize', onResize)

    let raf = 0
    const loop = () => {
      if (!draggingRef.current) {
        setIdle(Date.now() - lastActiveRef.current > IDLE_MS)
        if (followRef.current) {
          const tx = clamp(mouseRef.current.x + 26, 8, window.innerWidth - W - 8)
          const ty = clamp(mouseRef.current.y + 30, 8, window.innerHeight - petH() - 8)
          posRef.current.x += (tx - posRef.current.x) * 0.045
          posRef.current.y += (ty - posRef.current.y) * 0.045
          applyPos()
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    const hello = setTimeout(
      () => showBubble('嗨～我是你的小助手！拖一拖可以移动，双击切换跟随，不理我我会偷偷打盹哦', 5600),
      1200,
    )

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(hello)
      clearTimeout(bubbleTimer.current)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
  }, [applyPos, clamp, petH, showBubble])

  // 拖拽
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    movedRef.current = 0
    lastActiveRef.current = Date.now()
    setIdle(false)
    setDragging(true)
    startRef.current = {
      x: e.clientX,
      y: e.clientY,
      ox: posRef.current.x - e.clientX,
      oy: posRef.current.y - e.clientY,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    movedRef.current = Math.max(
      movedRef.current,
      Math.abs(e.clientX - startRef.current.x) + Math.abs(e.clientY - startRef.current.y),
    )
    posRef.current.x = clamp(e.clientX + startRef.current.ox, 8, window.innerWidth - W - 8)
    posRef.current.y = clamp(e.clientY + startRef.current.oy, 8, window.innerHeight - petH() - 8)
    applyPos()
  }

  const endDrag = () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    lastActiveRef.current = Date.now()
    if (movedRef.current < 8) pat(idle)
  }

  const onDoubleClick = () => {
    lastActiveRef.current = Date.now()
    const next = !followRef.current
    followRef.current = next
    setFollow(next)
    setIdle(false)
    showBubble(next ? '好呀～我跟着鼠标走啦！' : '收到！那我在这儿乖乖等你', 3200)
  }

  const rootClass = [
    follow ? 'follow-on' : '',
    dragging ? 'dragging' : '',
    idle ? 'pet-idle' : '',
    patting ? 'patting' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div id="desk-pet" ref={rootRef} className={rootClass}>
      <div
        id="pet-bubble"
        className={`glass-card relative mb-2 rounded-2xl px-4 py-3 text-[13px] leading-6 text-[color:var(--text-1)] ${
          bubble.show ? 'show' : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
      >
        <span>{bubble.text}</span>
      </div>

      <div
        className="pet-figure"
        title="拖拽移动 · 单击摸摸头 · 双击切换跟随"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      >
        <span id="pet-mode">
          <span className="dot" />
          <span>{follow ? '跟随中' : '已停靠'}</span>
        </span>

        <div className="pet-fx">
          {sparks.map((s) => (
            <span
              key={s.id}
              className="pet-spark"
              style={{
                left: s.left,
                top: s.top,
                color: s.heart ? 'var(--pet-pink)' : 'var(--accent)',
                animationDelay: `${s.delay}s`,
              }}
            >
              {s.heart ? HEART : STAR}
            </span>
          ))}
        </div>

        <div id="pet-zzz" aria-hidden="true">
          <span>z</span>
          <span>Z</span>
          <span>Z</span>
        </div>

        <img className="pet-img" src={petMascot} alt="桌宠小助手" draggable={false} />
      </div>
    </div>
  )
}
