# MCP 接入

TraceMind 以 MCP 服务暴露知识库检索、文档管理、长期记忆和检索调优，供 AI Agent 直接调用。每次调用都以令牌所属账号的身份执行，权限与该账号在网页中完全一致。

## 连接方式

| 方式 | 地址 / 命令 | 说明 |
| --- | --- | --- |
| Streamable HTTP（推荐） | `http://127.0.0.1:8010/mcp` | 随 `./scripts/dev.sh` 启动，与 API 共用进程和后台任务队列 |
| stdio | `cd backend && RAG_MCP_TOKEN=rwb_... .venv/bin/python -m app.mcp_server` | 上传的文档仍需 API 进程的 worker 解析；无 API 进程时加 `--with-worker` |

仅允许本机访问。两种方式都必须提供**个人访问令牌**：登录网页 →「我的账户」→「MCP 访问令牌」→ 新建（令牌只显示一次）。HTTP 用请求头 `Authorization: Bearer rwb_...`，stdio 用环境变量 `RAG_MCP_TOKEN` 或参数 `--token`。缺少或无效令牌返回 401；账号停用、令牌吊销或过期后立即失效。

Claude Code：

```bash
claude mcp add --transport http tracemind http://127.0.0.1:8010/mcp --header "Authorization: Bearer rwb_..."
```

通用 JSON 配置（Claude Desktop / Cursor 等，stdio）：

```json
{
  "mcpServers": {
    "tracemind": {
      "command": "/绝对路径/TraceMind/backend/.venv/bin/python",
      "args": ["-m", "app.mcp_server"],
      "cwd": "/绝对路径/TraceMind/backend",
      "env": { "RAG_MCP_TOKEN": "rwb_..." }
    }
  }
}
```

所有 ID 都是十进制字符串。

## 权限与范围

| | 平台（`platform`） | 个人（`personal`） |
| --- | --- | --- |
| 知识库 | 所有账号可见、可检索；管理员创建和管理（改配置、更新/删除文档）。员工上传的文档 `review_status=pending`，管理员审批通过后才解析入库 | 任何账号可创建，仅本人可见（管理员也看不到） |
| 记忆 | 所有账号可读，问答时自动参与个性化；管理员直接写入，员工的 `memory_add(scope="platform")` 成为待审批提议 | 仅本人，默认范围 |

- 评测调优与审批工具（`dataset_list`、`tuning_*`、`review_*`）仅管理员可用。
- 每次工具调用都写入管理员可见的 MCP 调用日志：账号、令牌、工具名、耗时、状态，参数只记录编号、数值和文本长度，不记录正文。
- `rag_search` / `rag_answer` 另外写入查询日志：平台知识库记录问题原文，个人知识库只记录元数据（不含问题）。

## 工具

### 知识库与召回

| 工具 | 作用 |
| --- | --- |
| `whoami` | 当前令牌对应的账号与角色 |
| `kb_list` | 列出可见知识库（平台 + 本人个人库）、`scope`、`can_manage`、文档/分块数量和默认检索配置 |
| `kb_create` | 新建知识库；`scope="personal"`（默认）或 `"platform"`（仅管理员） |
| `kb_set_retrieval_config` | 设置或清除知识库默认检索流水线（需管理权限） |
| `rag_search` | 只召回不生成；返回片段、分数和逐阶段 trace |
| `rag_answer` | 带引用校验的问答；`use_memory=true`（默认）时用调用者的个人记忆和平台记忆做个性化（记忆不会作为引用） |

`rag_search` 的 `method`：`auto`（知识库调优后的默认配置，否则 `hybrid_rerank`）、`bm25`、`vector`、`hybrid`、`hybrid_rerank`；`retrieval` 传完整配置可覆盖；`document_ids` 限定文档范围。

### 文档

| 工具 | 作用 |
| --- | --- |
| `document_list` / `document_get` | 列表、状态（含 `review_status`），可选返回解析文本。待审批文档仅上传者和管理员可见 |
| `document_upload` | Markdown/TXT 用 `content` 传文本；PDF 用 `content_base64`。异步处理，轮询 `document_get` 到 `status=ready`；员工上传到平台库时为 `status=pending_review`，等待审批 |
| `document_update` | 无中断替换：新版本就绪后自动删除旧版本；新版本失败时旧版本保留（需管理权限） |
| `document_delete` | 删除向量、分块、元数据和原文件（需管理权限；上传者可撤回自己待审批的文档） |

### 记忆

除 `memory_extract` / `memory_clear`（只作用于个人记忆）外，记忆工具都接受 `scope`：`personal`（默认）或 `platform`。

| 工具 | 作用 |
| --- | --- |
| `memory_add` | 写入一条记忆；按规范化文本或向量相似度去重（`on_duplicate`: skip / update / insert）。员工写平台记忆返回 `action=pending` |
| `memory_search` | 向量 + BM25 混合检索该范围的有效记忆 |
| `memory_list` / `memory_get` | 分页列表 / 单条；`status` 支持 active/pending/rejected/merged/deleted/all（员工在平台范围只看到自己的提议） |
| `memory_update` | 修改内容/分类/标签/重要度；传 `expected_version` 防止覆盖并发修改（平台范围仅管理员） |
| `memory_delete` / `memory_restore` | 软删除（可恢复）或 `hard=true` 彻底清除（平台范围仅管理员；员工可撤回自己的待审批提议） |
| `memory_merge` | 合并 2 条以上记忆为新记忆；未给 `content` 时由对话模型整合（平台范围仅管理员） |
| `memory_history` | 审计记录（create/update/delete/restore/merge/purge/pending/approve/reject，含前后快照） |
| `memory_extract` | 从对话文本抽取个人长期记忆并去重写入（调用对话模型） |
| `memory_clear` | 清空本人全部个人记忆（需 `confirm=true`） |

### 审批（管理员）

| 工具 | 作用 |
| --- | --- |
| `review_list` | 待审批的平台库文档（含知识库名、上传者）和平台记忆提议 |
| `review_decide` | `kind` 为 `document` 或 `memory`，`approve=true` 通过（文档开始解析）或 `false` 驳回（文档原文件删除） |

### 评估调优（管理员）

| 工具 | 作用 |
| --- | --- |
| `dataset_list` | 评测集列表 |
| `tuning_start` | 启动纯检索调优：显式候选、`grid` 参数网格或内置预设 |
| `tuning_status` | 进度与排行榜 |
| `tuning_apply` | 把某个候选设为知识库默认检索配置 |

## 计费

会调用对话模型、可能产生费用的：`rag_answer`、`memory_extract`、未提供 `content` 的 `memory_merge`、`query_rewrite=multi_query` 的检索。Embedding / Rerank 在入库、检索和记忆写入时调用。

## 推荐 Agent 流程

1. 回答前：`memory_search(问题)` 取个人偏好（需要时加 `scope="platform"` 取团队约定），`rag_search` 或 `rag_answer` 取知识。
2. 回答后：用户表达了稳定偏好或事实时 `memory_add`；长对话结束后可 `memory_extract`。
3. 定期：`memory_list` 检查相近条目，用 `memory_merge` 合并重复。
