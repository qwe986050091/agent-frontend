# 移动端 App 对齐 PC 前端功能 + 图片替换

## Context（背景）

PC 前端（agent_frontend）已有完整的四大模块：首页、聊天、知识库、技能管理；移动端 App（agent_mobile，Expo SDK 57）目前只有登录和聊天两个页面。用户要求：

1. 把 PC 端缺失的功能补齐到移动端（首页、知识库、技能管理，以及聊天页的"已挂载技能"展示）
2. 前端刚改过的图片在移动端同步替换（前端 git 工作区改的是 `character-home.jpg`，移动端还没有这张图；`app-icon.jpg` / `assistant-avatar.jpg` 两端哈希已一致，无需动）

后端接口（agent_backend）与 PC 端同源，移动端直连 `https://api.zlfshop.xyz` 即可复用全部接口，已确认契约。

## 关键决策

- **导航**：登录后进入底部 Tab（首页/聊天/知识库/技能），登录态条件渲染保持在 Stack 层（`user ? Main : Login`），登录页无 tab 栏；所有屏幕 `headerShown: false` + 自绘 header（沿用现有风格）
- **图标**：`@expo/vector-icons`（Ionicons，SDK 57 已 pin ^15.0.2，Expo Go 内置可用）
- **文件上传**：RN 内置 `XMLHttpRequest` 支持 `upload.onprogress` 真实进度；知识库上传必须设 `xhr.timeout = 120000`（Android OkHttp 默认 read timeout 10s，后端切块+向量化在响应前执行，首次可能十几秒）
- **选文件**：`expo-document-picker`，SDK 57 新 API `getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })` → `{ canceled, assets: [{uri, name, size, mimeType}] }`；扩展名/5MB 客户端预校验（后端也校验）
- **app.json 不改**：document-picker 的 config plugin 仅用于 iOS iCloud entitlement，Expo Go/Android 开箱即用
- **tools 多选**：chip 多选（Pressable 数组 + `selectedTools: string[]`），不引额外依赖
- **删除确认**：`Alert.alert` 双按钮（RN 无 Popconfirm）
- **上传进度 UI**：页面内条件卡片（uploading → processing 两阶段），不用 Alert/Modal

## 实施步骤

### 1. 安装依赖（d:\code\agent_mobile）

```powershell
npx expo install expo-document-picker @expo/vector-icons
pnpm add @react-navigation/bottom-tabs
```

### 2. 修改 `src/api.ts`（基础层）

**修复 `api()` 对 FormData 的误处理**（现有 bug）：当前 `typeof body !== 'string'` 会把 FormData JSON 序列化。改为：`options.body instanceof FormData` 时直接透传且不设 Content-Type（RN fetch 自动生成 multipart boundary）。

**新增类型**：`Skill`（name/shortDescription/detailedDescription/systemPrompt/builtin/mounted/createdBy/toolNames[]）、`SkillUploadPayload`、`KnowledgeDoc`（id/docName/docType/chunkCount/createdAt）、`UploadFileSource`（uri/name/type?）

**新增函数**：
- `listSkills()` GET /api/skills → `skills[]`
- `listTools()` GET /api/skills/tools → `tools[]`
- `uploadSkill(payload)` POST /api/skills/upload（JSON body：name/shortDescription/detailedDescription/systemPrompt/toolNames）
- `uploadSkillFile({uri,name,type})` POST /api/skills/upload（FormData，字段 `file`，RN 文件对象 `{uri,name,type} as any`）
- `mountSkill/unmountSkill(skillName)` POST /api/skills/mount|unmount，body `{skillName}`
- `deleteSkill(name)` DELETE /api/skills/{encodeURIComponent(name)}
- `listDocuments()` GET /api/knowledge/documents → `documents[]`
- `deleteDocument(id)` DELETE /api/knowledge/documents/{id}
- `uploadDocument(file, onProgress)` —— 裸 XHR：先 `await getToken()` 再建连接，设 `Authorization` 头、`xhr.timeout = 120000`、`xhr.upload.onprogress` 报 0-100 进度、401 走 `fireUnauthorized()`、错误统一 `ApiError`

### 3. 新建 `src/types/navigation.ts` + 改 `App.tsx`

- navigation.ts：`RootStackParamList { Login, Main }`、`MainTabParamList { Home, Chat, Knowledge, Skills }`
- App.tsx：Stack 层条件渲染 `user ? Main : Login`；`MainTabs` = `createBottomTabNavigator` 4 个 Tab.Screen：
  - Home（home/home-outline）、Chat（chatbubble-ellipses/-outline）、Knowledge（book/book-outline）、Skills（apps/apps-outline），图标名 `as any`
  - `headerShown: false`、`tabBarActiveTintColor: '#4d86ff'`、`tabBarInactiveTintColor: '#8590a6'`、`tabBarStyle` 白底、`tabBarHideOnKeyboard: true`、`sceneStyle: { backgroundColor: '#fff' }`（v7 的 sceneContainerStyle 已改名）

### 4. 新建 `src/screens/HomeScreen.tsx`

自绘 header（"首页"）+ ScrollView：徽章"你的专属 AI 助手" → 标题"你好呀，{nickname}"（渐变强调）→ 副标语 → 主按钮"开始新对话"（`navigation.navigate('Chat')`）+ 双卡片（知识库/技能管理）→ 4 个能力 chips（`✨ 自然对话 / 📚 知识库问答 / 🧩 技能挂载 / ☁️ 随时陪伴`，flexWrap）→ 立绘 `character-home.jpg`（白底圆角卡片 + `rgba(77,134,255,0.14)` 光晕 + shadow，照搬 ChatScreen 的 hero 模式，不做动画）

### 5. 新建 `src/screens/KnowledgeScreen.tsx`

- header "知识库" + "上传知识文档"卡片（大 Pressable 上传区 + 说明 .txt/.md）
- 选文件 → 客户端校验扩展名/5MB → `uploadDocument` 上传，页面内进度条：uploading 显示百分比 → 100% 转 processing（ActivityIndicator + "正在切块并向量化（首次处理可能需要十几秒）…"）→ 成功 `Alert` 显示 `《name》已切分为 N 个片段`
- 文档列表 FlatList：文件名 + docType Tag（geekblue 风格）+ `{chunkCount} 片段` Tag + 上传时间 `new Date(createdAt).toLocaleString('zh-CN')` + 右侧红色删除按钮（Alert 确认）
- 空态：assistantAvatar + "还没有知识文档，上传一个试试吧"

### 6. 新建 `src/screens/SkillsScreen.tsx`

- 并行 `Promise.all([listSkills(), listTools()])`
- 技能卡片列表（ScrollView）：名称 + `内置`(灰)/`自定义`(金) + `已挂载`(蓝) Tag + 短描述 + toolNames chips + 挂载/卸载按钮（挂载态主色实底）；非内置显示删除按钮（Alert 确认）
- 上传新技能：
  - "从 JSON 文件上传"按钮：document picker → 校验 .json → `uploadSkillFile`
  - 在线表单：技能名称（必填）/短描述/详细描述（multiline 2 行）/System Prompt（multiline 4 行，`textAlignVertical: 'top'`）/关联内置工具 chip 多选 → `uploadSkill` → 成功后清空表单并刷新

### 7. 修改 `src/screens/ChatScreen.tsx`（已挂载技能 chips）

- `useFocusEffect`（来自 @react-navigation/native，tab 切回时刷新）加载 `/api/skills` 过滤 `mounted`
- 输入框上方横向 ScrollView chips："已挂载技能" 标签 + 各技能 chip（`#eef2fb` 底、`#4d86ff` 字，点击 Alert 显示短描述）
- 空态副标语追加"可在「技能管理」中挂载工具技能"
- 验证 iOS 弹键盘时输入框不被遮挡（`keyboardVerticalOffset` 必要时 90 → 120）

### 8. 复制图片

```powershell
Copy-Item d:\code\agent_frontend\src\assets\character-home.jpg d:\code\agent_mobile\assets\character-home.jpg
```

（app-icon.jpg / assistant-avatar.jpg 两端哈希一致，不动；app.json 不加 document-picker plugin）

## 文件清单

| 操作 | 文件 |
|---|---|
| 修改 | `d:\code\agent_mobile\src\api.ts`（FormData 修复 + 10 个新函数/类型） |
| 新建 | `d:\code\agent_mobile\src\types\navigation.ts` |
| 修改 | `d:\code\agent_mobile\App.tsx`（底部 Tab + MainTabs） |
| 新建 | `d:\code\agent_mobile\src\screens\HomeScreen.tsx` |
| 新建 | `d:\code\agent_mobile\src\screens\KnowledgeScreen.tsx` |
| 新建 | `d:\code\agent_mobile\src\screens\SkillsScreen.tsx` |
| 修改 | `d:\code\agent_mobile\src\screens\ChatScreen.tsx`（已挂载技能 chips） |
| 修改 | `d:\code\agent_mobile\package.json`（新增 3 个依赖） |
| 复制 | `d:\code\agent_mobile\assets\character-home.jpg` |
| 不改 | `app.json`、`src/config.ts` |

## 验证

```powershell
cd d:\code\agent_mobile
npx tsc --noEmit        # 类型检查
npx expo start          # Expo Go 手动验证
```

手动清单：
1. 登录 → 底部 4 tab 出现、图标 focused/outline 正常；登录页无 tab 栏
2. 首页三入口跳对应 tab，立绘显示正常
3. 知识库：选 .txt 上传 → 进度 100% → 向量化阶段 → 成功 Alert + 列表刷新；删除有确认；非文本/超 5MB 被拦截
4. 技能管理：列表、挂载/卸载、删除（非内置）、chip 多选上传、.json 文件上传
5. 聊天：已挂载技能 chips 显示；技能页挂载后切回聊天 chips 更新（useFocusEffect）
6. 401 全局登出仍生效
