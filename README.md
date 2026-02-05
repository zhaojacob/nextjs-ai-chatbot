<a href="https://chat.vercel.ai/">
  <img alt="Next.js 14 and App Router-ready AI chatbot." src="app/(chat)/opengraph-image.png">
  <h1 align="center">Chat SDK</h1>
</a>

<p align="center">
    Chat SDK is a free, open-source template built with Next.js and the AI SDK that helps you quickly build powerful chatbot applications.
</p>

<p align="center">
  <a href="https://chat-sdk.dev"><strong>Read Docs</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#model-providers"><strong>Model Providers</strong></a> ·
  <a href="#deploy-your-own"><strong>Deploy Your Own</strong></a> ·
  <a href="#running-locally"><strong>Running locally</strong></a>
</p>
<br/>

## 自定义修改说明

本项目基于 Vercel AI Chatbot 模板修改，连接自定义的 Render 后端 (LangGraph Data Agent)。

### 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Vercel (Next.js)                          │
│                                                              │
│   Frontend ──→ /api/chat ──→ fetch() ─────────────────────┼──┐
│                                                              │  │
└─────────────────────────────────────────────────────────────┘  │
                                                                  │
                                                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    Render (Python)                           │
│                                                              │
│   /api/agent/stream ──→ LangGraph Agent ──→ AI Response     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 主要修改

| 修改项 | 原实现 | 新实现 | 修改文件 |
|--------|--------|--------|----------|
| AI 调用 | Vercel AI SDK `streamText` | `fetch` 调用 Render 后端 | `app/(chat)/api/chat/route.ts` |
| 后端地址 | Vercel AI Gateway | `RENDER_BACKEND_URL` 环境变量 | `.env.local` |
| SSE 格式 | Vercel AI SDK 格式 | LangGraph → Vercel 格式转换 | `app/(chat)/api/chat/route.ts` |
| 标题生成 | AI 生成摘要 | 消息前 50 字符截取 | `app/(chat)/actions.ts` |

### 修改的文件清单

1. **`app/(chat)/api/chat/route.ts`** - 核心修改
   - 移除了 `streamText` 和 AI 工具相关代码
   - 添加了 `callRenderBackend()` 函数调用后端
   - 添加了 `transformBackendStream()` 函数转换 SSE 格式
   - 添加了 `extractMessageText()` 函数提取消息文本

2. **`.env.example`** - 环境变量
   - 添加了 `RENDER_BACKEND_URL` 配置项

3. **`app/(chat)/actions.ts`** - 标题生成
   - 修改为使用消息截取方式生成标题

### SSE 流格式转换详解

#### 为什么需要遵守 Vercel AI SDK UI Message Stream Protocol？

虽然我们绕过了 Vercel AI SDK 的**后端部分**（`streamText`、AI Gateway），但**前端部分**仍然使用 Vercel 的 `@ai-sdk/react`：

```typescript
// components/chat.tsx
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

const { messages, sendMessage, ... } = useChat<ChatMessage>({
  transport: new DefaultChatTransport({ api: "/api/chat", ... }),
  ...
});
```

**绕过的（后端）：**
- Vercel AI SDK 的 `streamText()` 函数
- Vercel AI Gateway
- AI 工具（getWeather, createDocument 等）

**仍在使用的（前端）：**
- `@ai-sdk/react` 的 `useChat` hook
- `DefaultChatTransport`
- 前端 UI 组件（消息渲染、状态管理等）

因此，后端 API 必须返回 `useChat` hook 期望的格式（UI Message Stream Protocol），否则前端无法正确解析和显示消息。

**替代方案**：完全重写前端，不使用 `useChat` hook，自己处理 SSE 流。但这需要重写大量代码，不符合"最小修改"原则。

#### Vercel AI SDK v6 UI Message Stream Protocol

AI SDK v6 使用标准 SSE 格式，每个事件是 `data: JSON\n\n`：

| 类型 | 说明 | 格式示例 |
|------|------|----------|
| start | 消息开始 | `data: {"type": "start", "messageId": "..."}\n\n` |
| text-start | 文本块开始 | `data: {"type": "text-start", "id": "..."}\n\n` |
| text-delta | 文本增量 | `data: {"type": "text-delta", "id": "...", "delta": "文本"}\n\n` |
| text-end | 文本块结束 | `data: {"type": "text-end", "id": "..."}\n\n` |
| finish | 消息完成 | `data: {"type": "finish", "finishReason": "stop"}\n\n` |
| error | 错误 | `data: {"type": "error", "errorText": "..."}\n\n` |
| [DONE] | 流结束 | `data: [DONE]\n\n` |

响应头必须包含：`x-vercel-ai-ui-message-stream: v1`

参考文档：
- [Vercel AI SDK Stream Protocol](https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol)
- [UI Message Chunks 源码](https://github.com/vercel/ai/blob/master/packages/ai/src/ui-message-stream/ui-message-chunks.ts)

#### 后端格式 (LangGraph `stream_mode="updates"`)

后端使用 LangGraph 的 `create_react_agent`，通过 `agent.stream()` 返回 SSE 流。

**LangGraph 节点名称：**
- `agent` / `model` - 调用 LLM 的节点（显示给用户）
- `tools` - 执行工具的节点（跳过，避免显示原始 JSON）

**后端封装后的 SSE 格式：**
```
data: {"node": "model", "content": "AI 回复内容"}
data: {"node": "tools", "content": "工具执行结果"}
data: [DONE]
```

**关键特性：** `stream_mode="updates"` 返回的是**每步的增量消息**，不是累积内容。

#### 转换逻辑

`transformBackendStream()` 函数负责将 LangGraph 格式转换为 Vercel AI SDK UI Message Stream Protocol：

1. 解析后端 SSE 数据：`data: {"node": "model", "content": "..."}`
2. 只处理 `node === "agent"` 或 `node === "model"` 的消息（跳过 tools 输出）
3. 首次收到文本时发送 `text-start`
4. 每次收到文本发送 `text-delta`
5. 流结束时发送 `text-end`、`finish` 和 `[DONE]`

**完整的消息流示例：**
```
data: {"type": "start", "messageId": "uuid-1"}

data: {"type": "text-start", "id": "uuid-2"}

data: {"type": "text-delta", "id": "uuid-2", "delta": "你好"}

data: {"type": "text-delta", "id": "uuid-2", "delta": "，我是AI助手"}

data: {"type": "text-end", "id": "uuid-2"}

data: {"type": "finish", "finishReason": "stop"}

data: [DONE]
```

### 已禁用功能

| 功能 | 原因 | 影响 |
|------|------|------|
| autoResume (可恢复流) | Render 后端不支持 Vercel AI SDK 的 Resumable Streams | 页面刷新时如果 AI 正在回复，回复会中断，需要重新提问 |
| AI 标题生成 | 避免调用 Vercel AI Gateway | 对话标题使用消息前 50 字符，而非 AI 生成的摘要 |
| AI 工具 | 工具在后端 LangGraph Agent 中实现 | 前端不再直接调用 AI 工具 |

### 环境变量

```bash
# 必需
AUTH_SECRET=xxx                                    # 认证密钥
RENDER_BACKEND_URL=https://data-agent-v1.onrender.com  # Render 后端地址
POSTGRES_URL=xxx                                   # PostgreSQL 数据库连接

# 可选
REDIS_URL=xxx                                      # Redis（如需启用 Resumable Streams）
```

### 后端 API 说明

**接口：** `POST /api/agent/stream`

**请求格式：**
```json
{
  "message": "用户消息文本",
  "thread_id": "会话ID（用于 LangGraph 记忆功能）"
}
```

**响应格式：** SSE 流（见上文 SSE 流格式转换详解）

### 参考文档

- [LangGraph Streaming](https://docs.langchain.com/oss/python/langgraph/streaming)
- [LangGraph create_react_agent](https://reference.langchain.com/python/langgraph/agents/)
- [Vercel AI SDK useChat](https://sdk.vercel.ai/docs/reference/ai-sdk-ui/use-chat)

---

## Features

- [Next.js](https://nextjs.org) App Router
  - Advanced routing for seamless navigation and performance
  - React Server Components (RSCs) and Server Actions for server-side rendering and increased performance
- [AI SDK](https://ai-sdk.dev/docs/introduction)
  - Unified API for generating text, structured objects, and tool calls with LLMs
  - Hooks for building dynamic chat and generative user interfaces
  - Supports xAI (default), OpenAI, Fireworks, and other model providers
- [shadcn/ui](https://ui.shadcn.com)
  - Styling with [Tailwind CSS](https://tailwindcss.com)
  - Component primitives from [Radix UI](https://radix-ui.com) for accessibility and flexibility
- Data Persistence
  - [Neon Serverless Postgres](https://vercel.com/marketplace/neon) for saving chat history and user data
  - [Vercel Blob](https://vercel.com/storage/blob) for efficient file storage
- [Auth.js](https://authjs.dev)
  - Simple and secure authentication

## Model Providers

This template uses the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) to access multiple AI models through a unified interface. The default configuration includes [xAI](https://x.ai) models (`grok-2-vision-1212`, `grok-3-mini`) routed through the gateway.

### AI Gateway Authentication

**For Vercel deployments**: Authentication is handled automatically via OIDC tokens.

**For non-Vercel deployments**: You need to provide an AI Gateway API key by setting the `AI_GATEWAY_API_KEY` environment variable in your `.env.local` file.

With the [AI SDK](https://ai-sdk.dev/docs/introduction), you can also switch to direct LLM providers like [OpenAI](https://openai.com), [Anthropic](https://anthropic.com), [Cohere](https://cohere.com/), and [many more](https://ai-sdk.dev/providers/ai-sdk-providers) with just a few lines of code.

## Deploy Your Own

You can deploy your own version of the Next.js AI Chatbot to Vercel with one click:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/templates/next.js/nextjs-ai-chatbot)

## Running locally

You will need to use the environment variables [defined in `.env.example`](.env.example) to run Next.js AI Chatbot. It's recommended you use [Vercel Environment Variables](https://vercel.com/docs/projects/environment-variables) for this, but a `.env` file is all that is necessary.

> Note: You should not commit your `.env` file or it will expose secrets that will allow others to control access to your various AI and authentication provider accounts.

1. Install Vercel CLI: `npm i -g vercel`
2. Link local instance with Vercel and GitHub accounts (creates `.vercel` directory): `vercel link`
3. Download your environment variables: `vercel env pull`

```bash
pnpm install
pnpm db:migrate # Setup database or apply latest database changes
pnpm dev
```

Your app template should now be running on [localhost:3000](http://localhost:3000).
