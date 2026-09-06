---
name: "cloud-deploy"
description: "Agent 项目云端发布技能：前端静态站部署到旧阿里云服务器、agent/backend 两个 jar 部署到新腾讯云服务器，含上传、原子切换、重启、健康验证全流程。当用户要求部署/发布/上线前端或后端、更新云端服务时调用。"
---

# Agent 项目云端部署

本工作区（agent_frontend / agent / agent_backend 三工程）的标准化发布流程，已多次实战验证。
**仅在用户明确要求部署/发布/上线时执行；执行前简述本次将发布的内容与影响（后端重启有数秒中断）。**

## 环境拓扑（勿臆改）

| 角色 | 服务器 | SSH 别名 | 关键路径 |
|---|---|---|---|
| 前端静态站（Nginx + HTTPS） | 旧阿里云 123.56.82.34 | `old` | 站点目录 `/opt/agent/web`，域名 zlfshop.xyz，`/api/` 反代到新服务器 |
| agent 服务（8080，LangChain4j+RAG） | 新腾讯云 82.156.243.32 | `new` | jar：`/opt/agent/agent.jar`，systemd 服务名 `agent`，运行用户 agent |
| backend 服务（8081，业务后端） | 新腾讯云 82.156.243.32 | `new` | jar：`/opt/agent/agent-backend.jar`，systemd 服务名 `agent-backend` |
| RAG 向量快照 | 新服务器 | `new` | `/opt/agent/data/rag-embeddings.json`（agent 自动维护，勿手改） |

- SSH 配置已在 `C:\Users\zhanglingfeng\.ssh\config` 定义别名 `old`/`new`（密钥 D:\code\zlf_ali.pem / D:\code\zlf.pem）。**所有 ssh/scp 一律用别名**，用 `root@IP` 直连会因不匹配 Host 规则导致 publickey 拒绝。
- 若 SSH 连接超时：阿里云安全组 22 端口有 IP 白名单，需提醒用户把当前公网 IP 加入白名单。

## Windows/PowerShell 环境坑（必守）

1. **没有 `&&`**：命令串联用 `;`（`;` 不短路，关键步骤分开执行并检查结果）。
2. **`curl` 是 Invoke-WebRequest 别名**：本地验证用 `curl.exe`，或优先在远程服务器上执行 `curl`（更可靠）。
3. **ssh 远程命令内忌用复杂引号/双引号嵌套**（PowerShell→ssh→bash 三层转义易断）：
   - 需要发 JSON 时，本地写临时文件 → `scp` 上传 → 远程 `curl -d @/tmp/x.json`，用完删除。
   - 需要 grep 文件内容时，单独一条简单 ssh 命令执行。
4. **沙箱内 pnpm 无法写 store 数据库**：前端构建直接用 `node node_modules/vite/bin/vite.js build`（类型检查：`node node_modules/typescript/bin/tsc -b`），不要用 pnpm。
5. Java 构建用工程自带 `.\mvnw.cmd -q -DskipTests package`（已内置 JDK 自动探测与路径转义修复，本机无独立 mvn/JAVA_HOME）。

## 流程一：前端部署（旧服务器，零中断）

```powershell
# 1. 本地构建（cwd: d:\code\agent_frontend），确认 dist/assets 下生成新 hash 文件
node node_modules/vite/bin/vite.js build
node node_modules/typescript/bin/tsc -b   # 退出码 0 才继续

# 2. 上传到临时目录
ssh old "rm -rf /tmp/web-new && mkdir -p /tmp/web-new"
scp -r d:/code/agent_frontend/dist old:/tmp/web-new/

# 3. 原子切换（旧目录先改名备份，成功后删除；Nginx 读静态文件无需 reload）
ssh old "rm -rf /opt/agent/web.old && mv /opt/agent/web /opt/agent/web.old && mv /tmp/web-new/dist /opt/agent/web && rm -rf /opt/agent/web.old /tmp/web-new"

# 4. 服务器本机验证（Host 头模拟 HTTPS 站点）
ssh old "curl -sk -o /dev/null -w 'web: %{http_code}\n' https://127.0.0.1/ -H 'Host: zlfshop.xyz'; curl -sk -o /dev/null -w 'api: %{http_code}\n' https://127.0.0.1/api/health -H 'Host: zlfshop.xyz'; cat /opt/agent/web/index.html"
```

验收标准：web 200、api 200；index.html 引用的 assets hash 为本次构建的新文件；再用 WebFetch 抓 https://zlfshop.xyz/ 做公网确认。
注意：旧 hash 资源 URL 仍可能返回 200（SPA 回退到 index.html），以磁盘文件和 index.html 引用为准。

## 流程二：后端部署（新服务器，两个 jar，有数秒中断）

```powershell
# 1. 本地构建（两个工程分别执行，确认 target 下 jar 时间戳更新）
#    cwd: d:\code\agent          → .\mvnw.cmd -q -DskipTests package  → target/simple-agent-1.0.0.jar
#    cwd: d:\code\agent_backend  → .\mvnw.cmd -q -DskipTests package  → target/agent-backend-1.0.0.jar

# 2. 上传
scp d:/code/agent/target/simple-agent-1.0.0.jar new:/tmp/agent.jar.new
scp d:/code/agent_backend/target/agent-backend-1.0.0.jar new:/tmp/agent-backend.jar.new

# 3. 备份 + 替换（备份名 .bak-YYYYMMDD；属主必须改回 agent:agent）
ssh new "cd /opt/agent && cp agent.jar agent.jar.bak-YYYYMMDD && cp agent-backend.jar agent-backend.jar.bak-YYYYMMDD && mv /tmp/agent.jar.new agent.jar && mv /tmp/agent-backend.jar.new agent-backend.jar && chown agent:agent agent.jar agent-backend.jar"

# 4. 先重启 agent，健康后再重启 backend（backend 依赖 agent）
ssh new "systemctl restart agent && sleep 12 && systemctl is-active agent && curl -s -o /dev/null -w 'agent: %{http_code}\n' http://127.0.0.1:8080/api/agent/health && systemctl restart agent-backend && sleep 10 && systemctl is-active agent-backend && curl -s -o /dev/null -w 'backend: %{http_code}\n' http://127.0.0.1:8081/api/health"

# 5. 看启动日志确认无异常（关注新功能相关日志，如 [RAG] 快照加载）
ssh new "journalctl -u agent --since '2 minutes ago' --no-pager | grep -iE 'error|exception|RAG|Started' | tail -20"
```

验收标准：两个服务 `active`；8080/8081 健康检查 200；Nginx HTTPS `curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/api/health -H 'Host: api.zlfshop.xyz'` 为 200；日志无 ERROR。
回滚：把 `/opt/agent/*.jar.bak-YYYYMMDD` 改回正式名并重启对应服务。

## 通用纪律

- 只做本次发布所需的最小变更：**不动数据库、不删数据、不改 Nginx/系统配置**（除非本次需求明确要求）。
- 替换前必备份；先上传到 /tmp 校验文件大小后再切换。
- 部署后验证以"进程 active + 健康接口 200 + 关键日志"三者齐备为准，不能只看命令退出码。
- 前端发布不影响在线用户（刷新即新版，提示用户可 Ctrl+F5）；后端重启有数秒对话中断，提前告知。
