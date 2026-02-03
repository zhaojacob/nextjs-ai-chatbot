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

export const maxDuration = 60;

// Render Backend URL
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
 * Extract user message text from ChatMessage parts
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
 * Call Render backend and return SSE stream
 */
async function callRenderBackend(
  messageText: string,
  threadId: string
): Promise<Response> {
  if (!RENDER_BACKEND_URL) {
    throw new Error("RENDER_BACKEND_URL is not configured");
  }

  const response = await fetch(`${RENDER_BACKEND_URL}/agent/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: messageText,
      thread_id: threadId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Backend error: ${response.status}`);
  }

  return response;
}


/**
 * Transform Render backend SSE stream to frontend-compatible format
 * 
 * Backend format: data: {"agent": {"messages": [{"content": "..."}]}}
 * Frontend format: data: {"type": "text-delta", "textDelta": "..."}
 */
async function* transformBackendStream(
  backendResponse: Response
): AsyncGenerator<Uint8Array> {
  const reader = backendResponse.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastContent = "";

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
          
          if (data === "[DONE]") {
            // Send finish message
            yield encoder.encode(
              `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n\n`
            );
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            
            // Extract content from LangGraph response
            let content: string | null = null;
            
            // Handle different response formats from LangGraph
            if (parsed.agent?.messages) {
              const messages = parsed.agent.messages;
              const lastMessage = messages[messages.length - 1];
              if (lastMessage?.content && typeof lastMessage.content === "string") {
                content = lastMessage.content;
              }
            } else if (parsed.output) {
              // Handle /agent/invoke format
              content = parsed.output;
            } else if (typeof parsed === "string") {
              content = parsed;
            }

            // Only send new content (delta)
            if (content && content !== lastContent) {
              const delta = content.startsWith(lastContent) 
                ? content.slice(lastContent.length)
                : content;
              
              if (delta) {
                lastContent = content;
                yield encoder.encode(
                  `data: ${JSON.stringify({ type: "text-delta", textDelta: delta })}\n\n`
                );
              }
            }
          } catch (e) {
            // Ignore JSON parse errors
            console.log("Parse error for line:", line);
          }
        }
      }
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


    // Create a readable stream from the transformed backend response
    const transformedStream = new ReadableStream({
      async start(controller) {
        try {
          const assistantMessageId = generateUUID();
          let fullContent = "";

          // Send message start
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "message-start",
                message: {
                  id: assistantMessageId,
                  role: "assistant",
                  parts: [],
                },
              })}\n\n`
            )
          );

          // Transform and forward the backend stream
          for await (const chunk of transformBackendStream(backendResponse)) {
            controller.enqueue(chunk);
            
            // Accumulate content for database save
            const chunkStr = new TextDecoder().decode(chunk);
            const match = chunkStr.match(/"textDelta":"([^"]*)"/);
            if (match) {
              fullContent += match[1];
            }
          }

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
          if (titlePromise) {
            const title = await titlePromise;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: "data-chat-title", data: title })}\n\n`
              )
            );
            updateChatTitleById({ chatId: id, title });
          }

          controller.close();
        } catch (error) {
          console.error("Stream error:", error);
          controller.error(error);
        }
      },
    });

    // Return SSE response
    return new Response(transformedStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
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
