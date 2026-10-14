import { z } from "zod";
import {
  entityIdSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  sha256Schema,
  versionRefSchema
} from "./schemas.js";

export const DIRECTOR_V3_VERSION = "director-v3-1" as const;
export const SEEDANCE_PROMPT_V3_VERSION = "seedance-prompt-v3-1" as const;

/**
 * Director V3 剧本段落正文的违规词定义。
 *
 * 生成与修订模型仍会把【拍摄/剪辑提示】以及 镜头 / 机位 / 俯拍 / 特写 /
 * 字幕 / 大字 等拍摄与后期指令写进 beat.text，会触发剧本可生成性 QA 的
 * 零容忍规则（EDITING_INSTRUCTION_IN_STORY / BURNED_TEXT_INSTRUCTION）。
 * 剧本正文只应保留剧情动作与对白；镜头、切点与后期文字交给 Storyboard 与后期层。
 */
export const EDITING_DIRECTIVE_IN_TEXT =
  /(?:\d+(?:\.\d+)?\s*秒|硬切|快切|切到|镜头|机位|俯拍|特写|运镜|平均单镜头|字幕安全区)/g;
export const BURNED_TEXT_DIRECTIVE_IN_TEXT =
  /(?:字幕|大字|打出|文字|画面下方|画面上方|屏幕下方|屏幕上方|字样)/g;

const BRACKET_SEGMENT = /【[^】]*】|［[^］]*］/g;

/** 优先做可读性替换，让清洗后的句子仍然通顺，而不是留下断句。 */
const READABLE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/字幕安全区/g, "安全区"],
  [/平均单镜头/g, "平均段落时长"],
  [/画面下方/g, "画面下部"],
  [/画面上方/g, "画面上部"],
  [/屏幕下方/g, "屏幕下部"],
  [/屏幕上方/g, "屏幕上部"],
  [/硬切|快切/g, "转场"],
  [/切到/g, "转到"],
  [/镜头/g, "画面"],
  [/机位/g, "取景位置"],
  [/俯拍/g, "俯视"],
  [/特写/g, "近景"],
  [/运镜/g, "画面移动"],
  [/字幕/g, "文案"],
  [/大字/g, "醒目标题"],
  [/打出/g, "呈现"],
  [/文字/g, "文案"],
  [/字样/g, "样式"],
  [/\d+(?:\.\d+)?\s*秒/g, "片刻"]
];

/**
 * 确定性清洗单个剧本 Beat 的正文：
 * 1. 整体剥离【…】这类拍摄/剪辑提示段；
 * 2. 把残留的拍摄、机位、字幕等词替换成语义相近的剧情用词；
 * 3. 最后按 QA 同一套正则兜底删除，保证零容忍规则一定为 0。
 */
export function sanitizeScriptBeatText(text: string): string {
  let out = text.replace(BRACKET_SEGMENT, "");
  for (const [pattern, replacement] of READABLE_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(EDITING_DIRECTIVE_IN_TEXT, "");
  out = out.replace(BURNED_TEXT_DIRECTIVE_IN_TEXT, "");
  return out
    .replace(/([，。、；：,.;:])\1+/g, "$1")
    .replace(/^[，。、；：,.;:\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const scriptFeasibilityIssueCodeSchema = z.enum([
  "TOO_MANY_BEATS",
  "ACTION_DENSITY_HIGH",
  "SCENE_DENSITY_HIGH",
  "PRODUCT_STATE_DENSITY_HIGH",
  "EDITING_INSTRUCTION_IN_STORY",
  "BURNED_TEXT_INSTRUCTION",
  "AUDIO_INTENT_MISSING",
  "DURATION_OVERLOAD",
  "BEAT_DURATION_UNIFORM",
  "BEAT_SPEECH_OVERLOAD",
  "BEAT_ACTION_OVERLOAD",
  "BEAT_DURATION_IDLE",
  "NARRATIVE_DESCRIPTION_THIN",
  "NARRATIVE_TRANSITION_UNCLEAR",
  "NARRATIVE_DUPLICATE_BEAT"
]);

export const scriptFeasibilityIssueSchema = z.object({
  code: scriptFeasibilityIssueCodeSchema,
  severity: z.enum(["REVISE", "WARN"]),
  beatIds: z.array(entityIdSchema).default([]),
  message: nonEmptyStringSchema,
  suggestion: nonEmptyStringSchema
}).strict();

export const scriptFeasibilityReportSchema = z.object({
  version: z.literal(DIRECTOR_V3_VERSION),
  projectId: entityIdSchema,
  scriptRef: versionRefSchema,
  status: z.enum(["PASS", "REVISE"]),
  metrics: z.object({
    beatCount: z.number().int().nonnegative(),
    estimatedTotalMs: z.number().int().nonnegative(),
    detectedActionCount: z.number().int().nonnegative(),
    detectedSceneTransitionCount: z.number().int().nonnegative(),
    detectedProductStateChangeCount: z.number().int().nonnegative(),
    editingDirectiveCount: z.number().int().nonnegative(),
    burnedTextDirectiveCount: z.number().int().nonnegative()
  }).strict(),
  timingAudit: z.array(z.object({
    beatId: entityIdSchema,
    order: z.number().int().nonnegative(),
    assignedMs: z.number().int().positive(),
    estimatedSpeechMs: z.number().int().nonnegative(),
    estimatedActionMs: z.number().int().nonnegative(),
    minimumPlausibleMs: z.number().int().nonnegative(),
    sceneChanged: z.boolean()
  }).strict()).optional(),
  issues: z.array(scriptFeasibilityIssueSchema),
  createdAt: isoDateTimeSchema,
  contentHash: sha256Schema
}).strict();

export const directorV3AudioIntentSchema = z.object({
  mode: z.enum(["NATIVE", "SILENT"]).default("NATIVE"),
  dialogueOrOs: z.array(z.object({
    kind: z.enum(["DIALOGUE", "OS"]),
    text: nonEmptyStringSchema
  }).strict()).default([]),
  ambience: z.array(nonEmptyStringSchema).default([]),
  sfx: z.array(nonEmptyStringSchema).default([]),
  bgm: z.literal(false)
}).strict();

export const directorV3TimedActionSchema = z.object({
  order: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  description: nonEmptyStringSchema,
  productState: z.string().trim().min(1).optional()
}).strict().superRefine((value, ctx) => {
  if (value.endMs <= value.startMs) {
    ctx.addIssue({
      code: "custom",
      path: ["endMs"],
      message: "endMs must be greater than startMs"
    });
  }
});

export const directorV3ClipContractSchema = z.object({
  id: entityIdSchema,
  order: z.number().int().positive(),
  sourceBeatIds: z.array(entityIdSchema).min(1),
  purpose: nonEmptyStringSchema,
  location: nonEmptyStringSchema,
  durationMs: z.number().int().min(1000).max(120000),
  openingState: nonEmptyStringSchema,
  closingState: nonEmptyStringSchema,
  actions: z.array(directorV3TimedActionSchema).min(1).max(5),
  camera: z.object({
    shotSize: nonEmptyStringSchema,
    position: nonEmptyStringSchema,
    angle: nonEmptyStringSchema,
    movement: nonEmptyStringSchema
  }).strict(),
  referenceAssetIds: z.array(nonEmptyStringSchema).default([]),
  productStateChanges: z.array(nonEmptyStringSchema).max(3).default([]),
  audio: directorV3AudioIntentSchema,
  globalConstraints: z.object({
    preserveProductIdentity: z.boolean().default(true),
    noReadableText: z.boolean().default(true),
    noBgm: z.literal(true),
    extra: z.array(nonEmptyStringSchema).default([])
  }).strict()
}).strict().superRefine((clip, ctx) => {
  const sorted = [...clip.actions].sort((a, b) => a.order - b.order);
  if (sorted[0]?.startMs !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["actions", 0, "startMs"],
      message: "clip actions must start at 0"
    });
  }
  if (sorted.at(-1)?.endMs !== clip.durationMs) {
    ctx.addIssue({
      code: "custom",
      path: ["actions"],
      message: "clip actions must end at durationMs"
    });
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i - 1]!.endMs !== sorted[i]!.startMs) {
      ctx.addIssue({
        code: "custom",
        path: ["actions", i],
        message: "clip actions must be contiguous"
      });
      break;
    }
  }
});

export const directorV3PlanSchema = z.object({
  version: z.literal(DIRECTOR_V3_VERSION),
  projectId: entityIdSchema,
  scriptRef: versionRefSchema,
  targetDurationMs: z.number().int().min(10000).max(120000),
  clipContracts: z.array(directorV3ClipContractSchema).min(1),
  createdAt: isoDateTimeSchema,
  contentHash: sha256Schema
}).strict().superRefine((plan, ctx) => {
  const total = plan.clipContracts.reduce(
    (sum, clip) => sum + clip.durationMs,
    0
  );
  if (total !== plan.targetDurationMs) {
    ctx.addIssue({
      code: "custom",
      path: ["clipContracts"],
      message: "clip contract durations must equal targetDurationMs"
    });
  }
});

export const seedancePromptV3DraftSchema = z.object({
  version: z.literal(SEEDANCE_PROMPT_V3_VERSION),
  id: entityIdSchema,
  projectId: entityIdSchema,
  clipId: entityIdSchema,
  sourceContractHash: sha256Schema,
  status: z.enum(["DRAFT", "CONFIRMED"]),
  promptText: nonEmptyStringSchema,
  originalPromptText: nonEmptyStringSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  contentHash: sha256Schema
}).strict();

export type ScriptFeasibilityIssue = z.infer<
  typeof scriptFeasibilityIssueSchema
>;
export type ScriptFeasibilityReport = z.infer<
  typeof scriptFeasibilityReportSchema
>;
export type DirectorV3AudioIntent = z.infer<
  typeof directorV3AudioIntentSchema
>;
export type DirectorV3ClipContract = z.infer<
  typeof directorV3ClipContractSchema
>;
export type DirectorV3Plan = z.infer<
  typeof directorV3PlanSchema
>;
export type SeedancePromptV3Draft = z.infer<
  typeof seedancePromptV3DraftSchema
>;
