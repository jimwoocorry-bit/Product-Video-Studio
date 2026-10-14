import { z } from "zod";
import { DomainValidationError } from "../../domain/validation.js";

/** Explain a rejected model response without exposing raw validation JSON. */
export function parseAiProposal<T>(schema: z.ZodType<T>, value: unknown, stage: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const index = issue?.path[0] === "beats" && typeof issue.path[1] === "number" ? issue.path[1] : undefined;
  const field = String(issue?.path.at(-1) ?? "");
  const labels: Record<string, string> = {
    location: "场景", storyAction: "故事动作", productRole: "产品作用",
    stateIn: "起始状态", stateOut: "结束状态", productStateIn: "产品起始状态",
    productStateOut: "产品结束状态", dialogue: "对白", os: "旁白", text: "剧情描述",
    estimatedDurationMs: "预计时长", requiredFactIds: "事实引用", videoIntent: "故事意图",
    audioIntent: "声音设置", ambience: "环境声", sfx: "音效", bgm: "背景音乐设置",
    postProductionText: "后期文字"
  };
  const segment = index === undefined ? "" : "第" + (index + 1) + "段";
  const detail = labels[field] ? "的“" + labels[field] + "”" : "内容";
  throw new DomainValidationError("模型返回的" + stage + segment + detail + "缺失或格式不正确，请重新尝试当前步骤。");
}
