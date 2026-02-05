/**
 * ============================================================================
 * [自定义修改] Chat API Route - 连接 Render 后端 Data Agent
 * ============================================================================
 * 
 * 此文件基于 Vercel AI Chatbot 模板修改，将 AI 调用从 Vercel AI SDK 的 streamText
 * 改为调用部署在 Render 上的 LangGraph Data Agent 后端。
 * 
 * ## 主要修改
 * 
 * 1. 移除了 Vercel AI SDK 的 streamText 和相关工具
 * 2. 添加了 callRenderBackend 函数调用后端 /api/agent/stream 接口
 * 3. 添加了 transformBackendStream 函数转换 SSE 格式
 * 4. 保留了原有的认证、数据库操作、错误处理逻辑
 * 
 * ## 后端信息
 * 
 * - 后端地址：通过 RENDER_BACKEND_URL 环境变量配置
 * - API 接口：POST /api/agent/stream
 * - 请求格式：{ "message": "用户消息", "thread_id": "会话ID" }
 * - 响应格式：SSE 流，LangGraph stream_mode="updates"
 * 
 * ## 相关文档
 * 
 * - 详细修改说明见 README.md "自定义修改" 章节
 * - LangGraph Streaming: https://docs.langchain.com/oss/python/langgraph/streaming
 * ============================================================================
 */

import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import {
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  saveChat,
  saveMessages,
  updateChatTitleById,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 300; // [自定义修改] 增加到 5 分钟，因为 Agent 工具调用可能需要较长时间

// [自定义修改] Render Backend URL - 从环境变量读取后端地址
const RENDER_BACKEND_URL = process.env.RENDER_BACKEND_URL;

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

/**
 * [自定义修改] Extract user message text from ChatMessage parts
 * 
 * 从前端发送的 ChatMessage 结构中提取纯文本内容。
 * 前端消息格式：{ parts: [{ type: "text", text: "..." }, ...] }
 */
function extractMessageText(message: ChatMessage): string {
  if (!message.parts) return "";
  
  return message.parts
    .filter((part: { type: string; text?: string }): part is { type: "text"; text: string } => 
      part.type === "text" && typeof part.text === "string"
    )
    .map((part: { type: "text"; text: string }) => part.text)
    .join("\n");
}

/**
 * [自定义修改] Call Render backend and return SSE stream
 * 
 * 调用部署在 Render 上的 LangGraph Data Agent 后端。
 * 
 * @param messageText - 用户消息文本
 * @param threadId - 会话 ID（用于 LangGraph 的记忆功能）
 * @returns 后端返回的 SSE 流响应
 * 
 * 请求格式：
 *   POST /api/agent/stream
 *   Body: { "message": "用户消息", "thread_id": "会话ID" }
 * 
 * 注意：使用 AbortController 设置 10 分钟超时，因为 Agent 可能需要执行
 * 多个工具调用（数据库查询、网络搜索等），整个过程可能需要较长时间。
 */
async function callRenderBackend(
  messageText: string,
  threadId: string
): Promise<Response> {
  if (!RENDER_BACKEND_URL) {
    throw new Error("RENDER_BACKEND_URL is not configured");
  }

  // [自定义修改] 设置 10 分钟超时，因为 Agent 工具调用可能需要较长时间
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 minutes

  try {
    const response = await fetch(`${RENDER_BACKEND_URL}/api/agent/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: messageText,
        thread_id: threadId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}


/**
 * ============================================================================
 * [自定义修改] Transform Render backend SSE stream to frontend-compatible format
 * ============================================================================
 * 
 * 此函数将 LangGraph 后端的 SSE 流转换为 Vercel AI SDK v6 UI Message Stream 格式。
 * 
 * ## 后端格式 (LangGraph stream_mode="updates")
 * 
 * 后端封装后的 SSE 格式：
 *   data: {"node": "agent", "content": "AI 回复内容"}
 *   data: {"node": "tools", "content": "工具执行结果"}
 *   data: [DONE]
 * 
 * ## 前端期望格式 (Vercel AI SDK v6 UI Message Stream Protocol)
 * 
 * AI SDK v6 使用标准 SSE 格式，每个事件是 `data: JSON\n\n`：
 *   data: {"type": "start", "messageId": "..."}
 *   data: {"type": "text-start", "id": "..."}
 *   data: {"type": "text-delta", "id": "...", "delta": "文本内容"}
 *   data: {"type": "text-end", "id": "..."}
 *   data: {"type": "finish", "finishReason": "stop"}
 *   data: [DONE]
 * 
 * 参考：
 * - https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol
 * - https://github.com/vercel/ai/blob/master/packages/ai/src/ui-message-stream/ui-message-chunks.ts
 * ============================================================================
 */
async function* transformBackendStream(
  backendResponse: Response,
  _messageId: string,
  textId: string
): AsyncGenerator<string> {
  const reader = backendResponse.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let textStarted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          
          console.log("[Backend SSE]:", data.substring(0, 200));
          
          if (data === "[DONE]") {
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            
            // [自定义修改] 将 keep-alive 心跳转发给前端显示工作状态
            if (parsed.type === "ping") {
              const heartbeatMsg = { type: "data-heartbeat", data: { timestamp: Date.now() } };
              console.log("[Keep-alive ping received, forwarding to frontend]:", JSON.stringify(heartbeatMsg));
              yield `data: ${JSON.stringify(heartbeatMsg)}\n\n`;
              continue;
            }
            
            if (parsed.content && typeof parsed.content === "string") {
              const content = parsed.content;
              
              // 只处理 agent/model 节点，跳过 tools 节点
              if (parsed.node === "agent" || parsed.node === "model") {
                // [关键] 首次文本需要发送 text-start
                if (!textStarted) {
                  textStarted = true;
                  console.log("[Sending text-start]");
                  yield `data: ${JSON.stringify({ type: "text-start", id: textId })}\n\n`;
                }
                
                // [关键] 发送 text-delta
                console.log("[Sending text-delta]:", content.substring(0, 100));
                yield `data: ${JSON.stringify({ type: "text-delta", id: textId, delta: content })}\n\n`;
              }
            }
            else if (parsed.error) {
              console.error("[Backend error]:", parsed.error);
              yield `data: ${JSON.stringify({ type: "error", errorText: parsed.error })}\n\n`;
            }
          } catch (e) {
            console.log("Parse error for line:", line.substring(0, 100));
          }
        }
      }
    }
    
    // [关键] 如果有文本，发送 text-end
    if (textStarted) {
      console.log("[Sending text-end]");
      yield `data: ${JSON.stringify({ type: "text-end", id: textId })}\n\n`;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  try {
    const { id, message, selectedVisibilityType } = requestBody;

    // Check if RENDER_BACKEND_URL is configured
    if (!RENDER_BACKEND_URL) {
      console.error("RENDER_BACKEND_URL is not configured");
      return new ChatSDKError("bad_request:api").toResponse();
    }

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError("rate_limit:chat").toResponse();
    }

    const chat = await getChatById({ id });
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    // Save user message to database
    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    // Extract message text
    const messageText = message ? extractMessageText(message) : "";
    
    if (!messageText) {
      return new ChatSDKError("bad_request:api").toResponse();
    }

    // Call Render backend
    let backendResponse: Response;
    try {
      backendResponse = await callRenderBackend(messageText, id);
    } catch (error) {
      console.error("Backend call failed:", error);
      return new ChatSDKError("offline:chat").toResponse();
    }

    // Check if backend response has a body
    if (!backendResponse.body) {
      console.error("Backend response has no body");
      return new ChatSDKError("offline:chat").toResponse();
    }

    // Create a readable stream from the transformed backend response
    const transformedStream = new ReadableStream({
      async start(controller) {
        const assistantMessageId = generateUUID();
        const textId = generateUUID();  // [UI Message Stream] 每个文本块需要唯一 ID
        let fullContent = "";
        let isClosed = false;
        const encoder = new TextEncoder();

        const safeEnqueue = (data: string) => {
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode(data));
            } catch (e) {
              console.log("Enqueue error (controller may be closed)");
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch (e) {
              console.log("Close error (controller may already be closed)");
            }
          }
        };

        try {
          // [UI Message Stream Protocol] 发送 start 消息
          safeEnqueue(`data: ${JSON.stringify({ type: "start", messageId: assistantMessageId })}\n\n`);

          // Transform and forward the backend stream
          try {
            for await (const chunk of transformBackendStream(backendResponse, assistantMessageId, textId)) {
              safeEnqueue(chunk);
              
              // Accumulate content for database save
              // UI Message Stream 格式: data: {"type": "text-delta", "id": "...", "delta": "..."}
              try {
                // 解析 SSE 格式
                if (chunk.startsWith("data: ")) {
                  const jsonStr = chunk.slice(6).trim();
                  if (jsonStr && jsonStr !== "[DONE]") {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.type === "text-delta" && parsed.delta) {
                      fullContent += parsed.delta;
                    }
                  }
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          } catch (streamError) {
            console.error("Stream processing error:", streamError);
            // 发送错误消息
            safeEnqueue(
              `data: ${JSON.stringify({ type: "error", errorText: "Backend connection error. Please try again." })}\n\n`
            );
            fullContent = "Backend connection error. Please try again.";
          }

          // [UI Message Stream Protocol] 发送 finish 消息
          safeEnqueue(
            `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n\n`
          );
          
          // [UI Message Stream Protocol] 发送 [DONE] 标记
          safeEnqueue("data: [DONE]\n\n");

          // Save assistant message to database
          if (fullContent) {
            await saveMessages({
              messages: [
                {
                  chatId: id,
                  id: assistantMessageId,
                  role: "assistant",
                  parts: [{ type: "text", text: fullContent }],
                  attachments: [],
                  createdAt: new Date(),
                },
              ],
            });
          }

          // Update chat title if this is a new chat
          // [UI Message Stream Protocol] 使用 data-* 类型发送自定义数据
          if (titlePromise) {
            const title = await titlePromise;
            // 注意：title 更新在 finish 之后，可能不会被前端处理
            // 但数据库更新仍然有效
            updateChatTitleById({ chatId: id, title });
          }

          safeClose();
        } catch (error) {
          console.error("Stream error:", error);
          safeClose();
        }
      },
    });

    // Return response with UI Message Stream Protocol header
    return new Response(transformedStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-vercel-ai-ui-message-stream": "v1",  // [关键] 标识使用 UI Message Stream Protocol
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatSDKError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
