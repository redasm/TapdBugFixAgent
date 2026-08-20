/** 历史 Bug 离线评测：比较不同模型或 Prompt 运行的验证、范围和人工结果。 */

export interface EvaluationCase {
  bug_id: string;
  category: string;
  expected_files: string[];
  forbidden_files: string[];
  requires_verification: boolean;
}

export interface EvaluationCandidate {
  bug_id: string;
  changed_files: string[];
  verification_ok: boolean;
  review_approved: boolean;
  human_outcome?: string;
  reopened?: boolean;
}

export interface EvaluationReport {
  name: string;
  total: number;
  coverage: number;
  verified_rate: number;
  scope_precision: number;
  review_pass_rate: number;
  unchanged_acceptance_rate: number;
  effective_fix_rate: number;
  score: number;
}

const ratio = (n: number, d: number): number => d ? n / d : 0;

const samePath = (a: string, b: string): boolean =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

const scopeOk = (testCase: EvaluationCase, candidate: EvaluationCandidate): boolean => {
  const files = candidate.changed_files;
  const hitExpected = !testCase.expected_files.length
    || testCase.expected_files.some((expected) => files.some((file) => samePath(file, expected)));
  const hitForbidden = testCase.forbidden_files.some(
    (forbidden) => files.some((file) => samePath(file, forbidden)),
  );
  return hitExpected && !hitForbidden;
};

export const evaluateRun = (
  cases: EvaluationCase[],
  candidates: EvaluationCandidate[],
  name: string,
): EvaluationReport => {
  const byId = new Map(candidates.map((candidate) => [candidate.bug_id, candidate]));
  let covered = 0;
  let verified = 0;
  let scoped = 0;
  let reviewPassed = 0;
  let acceptedUnchanged = 0;
  let effective = 0;
  for (const testCase of cases) {
    const candidate = byId.get(testCase.bug_id);
    if (!candidate) continue;
    covered += 1;
    const verifiedOk = !testCase.requires_verification || candidate.verification_ok;
    if (verifiedOk) verified += 1;
    const scopedOk = scopeOk(testCase, candidate);
    if (scopedOk) scoped += 1;
    if (candidate.review_approved) reviewPassed += 1;
    if (candidate.human_outcome === "accepted_unchanged") acceptedUnchanged += 1;
    const accepted = candidate.human_outcome === "accepted_unchanged"
      || candidate.human_outcome === "accepted_modified";
    if (verifiedOk && scopedOk && candidate.review_approved && accepted && !candidate.reopened) effective += 1;
  }
  const total = cases.length;
  const coverage = ratio(covered, total);
  const verifiedRate = ratio(verified, covered);
  const scopePrecision = ratio(scoped, covered);
  const reviewPassRate = ratio(reviewPassed, covered);
  const unchangedAcceptanceRate = ratio(acceptedUnchanged, covered);
  const effectiveFixRate = ratio(effective, total);
  const score = effectiveFixRate * 0.45
    + verifiedRate * 0.15
    + scopePrecision * 0.15
    + reviewPassRate * 0.1
    + unchangedAcceptanceRate * 0.1
    + coverage * 0.05;
  return {
    name,
    total,
    coverage,
    verified_rate: verifiedRate,
    scope_precision: scopePrecision,
    review_pass_rate: reviewPassRate,
    unchanged_acceptance_rate: unchangedAcceptanceRate,
    effective_fix_rate: effectiveFixRate,
    score,
  };
};

export const compareEvaluationRuns = (reports: EvaluationReport[]): EvaluationReport[] =>
  [...reports].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
