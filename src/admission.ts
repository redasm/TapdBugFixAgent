import type { Bug } from "./models.js";
import {
  assessFixability,
  type AdmissionPolicy,
  type FixabilityAssessment,
} from "./quality.js";

const SECTION_LABELS = "复现步骤|重现步骤|操作步骤|复现|重现|预期结果|期望结果|预期|期望|实际结果|当前结果|实际|问题现象|现象|环境|版本|日志";

const descriptionSection = (description: string, labels: string[]): string => {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = description.match(
    new RegExp(`(?:${escaped})[：:]\\s*([\\s\\S]*?)(?=(?:${SECTION_LABELS})[：:]|$)`, "i"),
  );
  return match?.[1]?.trim() ?? "";
};

const enrichStructuredDescription = (bug: Bug): Bug => {
  const raw = { ...bug.raw };
  const reproduction = descriptionSection(bug.description, ["复现步骤", "重现步骤", "操作步骤", "复现", "重现"]);
  const expected = descriptionSection(bug.description, ["预期结果", "期望结果", "预期", "期望"]);
  const actual = descriptionSection(bug.description, ["实际结果", "当前结果", "实际", "问题现象", "现象"]);
  if (reproduction && !raw.reproduction_steps && !raw.steps) raw.reproduction_steps = reproduction;
  if (expected && !raw.expected_result && !raw.expected) raw.expected_result = expected;
  if (actual && !raw.actual_result && !raw.actual) raw.actual_result = actual;
  return { ...bug, raw };
};

/**
 * 保留原有高风险/资源门禁；普通工单只要存在描述就允许进入只读调查。
 * 描述不要求固定模板、标签或关键词；证据是否足够由只读调查阶段结合代码判断。
 */
export function assessFixabilityWithNarrative(
  bug: Bug,
  policy: AdmissionPolicy,
  automatableManualKeywords: string[] = [],
): FixabilityAssessment {
  const assessment = assessFixability(
    enrichStructuredDescription(bug),
    policy,
    automatableManualKeywords,
  );
  if (assessment.eligible || assessment.disposition !== "needs_info") return assessment;

  const title = assessment.context.title.trim();
  const vagueTitle = /^(?:bug|问题|异常|功能异常|有问题|待修复|需修复|优化)$/i.test(title);
  if (!assessment.context.description.trim() && (title.length < 8 || vagueTitle)) return assessment;

  return {
    ...assessment,
    eligible: true,
    disposition: "auto_fix",
    score: Math.max(assessment.score, policy.min_score),
    reasons: [],
  };
}
