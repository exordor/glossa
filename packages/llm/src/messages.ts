/** LlmMessage（可序列化，core 的形状）→ AI SDK 的 ModelMessage。 */
import type { LlmMessage } from "@reader/core";
import type { ModelMessage } from "ai";

/** 图片的文字替身（模型不支持图像时用）。 */
export const imageCaption = (alt?: string) => `[图：${alt?.trim() || "无图注"}]`;

export function toModelMessages(messages: LlmMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "user") {
      return {
        role: "user",
        content: m.content.map((p) =>
          p.type === "text"
            ? { type: "text" as const, text: p.text }
            : { type: "image" as const, image: p.dataBase64, mediaType: p.mediaType },
        ),
      };
    }
    // 助手消息里的图片没有意义，换成图注。
    return {
      role: "assistant",
      content: m.content.map((p) => ({ type: "text" as const, text: p.type === "text" ? p.text : imageCaption(p.alt) })),
    };
  });
}
