export type Paragraph = {
  id: string;
  html: string;
};

export type ExpectedCorrection = {
  find: string;
  replace: string;
};

export type IssueSeverity = "minor" | "major";
export type IssueEditScope = "character" | "token" | "phrase" | "clause" | "sentence" | "discourse";
export type IssueOperationType =
  | "substitution"
  | "omission"
  | "insertion"
  | "transposition"
  | "duplication"
  | "agreement_mismatch"
  | "boundary_error";
export type IssueDimension = "orthographic" | "lexical" | "grammatical" | "punctuation" | "semantic" | "stylistic";

export type IssueClassification = {
  label: string;
  parent: string;
  child: string;
  severity: IssueSeverity;
  editScope: IssueEditScope;
  operationType: IssueOperationType;
  createsValidWord: boolean | null;
  dimension: IssueDimension;
};

export type ProofreadingIssue = {
  id: string;
  category: string;
  paragraphId: string;
  description: string;
  classification?: IssueClassification;
  expectedCorrection: ExpectedCorrection;
};

export type ProofreadingCase = {
  id: string;
  instruction: string;
  paragraphs: Paragraph[];
  expectedParagraphs: Paragraph[];
  issues: ProofreadingIssue[];
};

export type ReplaceParagraphArgs = {
  paragraphId: string;
  newParagraphHtml: string;
};

export type FindAndReplaceArgs = {
  paragraphId: string;
  find: string;
  replace: string;
};

export type ProofreadingCompleteArgs = {
  note?: string;
};

export type ToolName = "replace_paragraph" | "find_and_replace" | "proofreading_complete";

export type ToolResult = {
  ok: boolean;
  paragraphId?: string;
  updatedParagraphHtml?: string;
  replacementsApplied?: number;
  decision?: ChunkDecision;
  message: string;
};

export type ToolExecution = {
  sequence: number;
  chunkIndex: number;
  turn: number;
  paragraphId: string | null;
  beforeParagraphHtml: string | null;
  afterParagraphHtml: string | null;
  toolCallId: string;
  toolName: ToolName;
  arguments: ReplaceParagraphArgs | FindAndReplaceArgs | ProofreadingCompleteArgs | Record<string, unknown>;
  result: ToolResult;
};

export type ChunkDecision = "continue" | "stop";

export type CaseChunkRun = {
  chunkName: string;
  chunkInstruction: string;
  chunkIndex: number;
  chunkCount: number;
  chunkParagraphIds: string[];
  startingDocumentHtml: string;
  endingDocumentHtml: string;
  turnTraces: PassTurnTrace[];
  toolExecutions: ToolExecution[];
  finalAssistantMessage: string;
  decision: ChunkDecision;
  outputTokens: number;
  promptTokens: number;
  durationMs: number;
};

export type PassTurnTrace = {
  turn: number;
  requestDurationMs: number;
  finishReason: string | null;
  assistantContent: string | null;
  toolCallCount: number;
  rawToolCallCount: number;
  rawContentPartTypes: string[];
  rawContentPreview: string | null;
  reasoningTextLength: number;
  reasoningDetailsCount: number;
};

export type RunCase = {
  caseId: string;
  instruction: string;
  initialDocumentHtml: string;
  expectedDocumentHtml: string;
  finalDocumentHtml: string;
  issues: ProofreadingIssue[];
  chunks: CaseChunkRun[];
  finalAssistantMessage: string;
  terminationReason: "model_stop" | "max_turns";
  outputTokens: number;
  promptTokens: number;
  durationMs: number;
};

export type RunArtifact = {
  version: "v1";
  runId: string;
  createdAt: string;
  datasetPath: string;
  maxWordsPerChunk?: number | null;
  maxTurnsPerChunk?: number | null;
  mode: "mock" | "live" | "openrouter";
  apiProvider?: string | null;
  apiEndpointLabel?: string | null;
  model: string;
  modelLabel?: string;
  reasoningEffort?: string | null;
  cases: RunCase[];
};

export type IssueScore = {
  issueId: string;
  category: string;
  paragraphId: string;
  description: string;
  classification?: IssueClassification;
  staticCorrected: boolean;
  attemptedChange: boolean;
  alternativeCandidate: boolean;
  corrected: boolean;
  resolutionMethod: "exact" | "alternative_judge" | "attempted_invalid" | "not_addressed";
};

export type JudgeIssueVerdict = {
  issueId: string;
  resolved: boolean;
  notes: string;
};

export type IntroducedError = {
  paragraphId: string;
  text: string;
  severity: IssueSeverity;
  notes: string;
};

export type UnnecessaryChange = {
  paragraphId: string;
  originalText: string;
  finalText: string;
  severity: IssueSeverity;
  harmful: boolean;
  notes: string;
};

export type CaseJudgeResult = {
  judgeModel: string;
  issueVerdicts: JudgeIssueVerdict[];
  allListedErrorsResolved: boolean;
  introducedNewErrors: boolean;
  introducedErrors: IntroducedError[];
  unnecessaryChanges: UnnecessaryChange[];
  collateralDamageCount: number;
  resolvedIssueCount: number;
  resolutionRate: number;
  restraintScore: number;
  qualityScore: number;
  benchmarkScore: number;
  overallPass: boolean;
  summary: string;
  outputTokens: number;
  promptTokens: number;
};

export type RunCostSummary = {
  candidatePromptTokens: number;
  candidateOutputTokens: number;
  candidateCostUsd: number | null;
  judgePromptTokens: number;
  judgeOutputTokens: number;
  judgeCostUsd: number | null;
  totalCostUsd: number | null;
};

export type RunAxesSummary = {
  quality: number | null;
  restraint: number | null;
  efficiency: number | null;
  speed: number | null;
  costUsd: number | null;
  candidateCostUsd: number | null;
  judgeCostUsd: number | null;
};

export type RunToolingSummary = {
  totalEditToolCalls: number;
  totalEditToolArgumentChars: number;
  benchmarkToolCalls: number;
  benchmarkToolArgumentChars: number;
  offTargetToolCalls: number;
  offTargetToolArgumentChars: number;
  benchmarkToolCallsPerResolvedIssue: number | null;
  benchmarkToolCharsPerResolvedIssue: number | null;
  offTargetToolCharsShare: number | null;
  benchmarkParagraphRewriteShare: number | null;
};

export type CaseScore = {
  caseId: string;
  exactDocumentMatch: boolean;
  correctedIssueCount: number;
  attemptedButInvalidIssueCount: number;
  notAddressedIssueCount: number;
  totalIssueCount: number;
  issueCoverage: number;
  outputTokens: number;
  promptTokens: number;
  correctionsPerOutputToken: number;
  tokensPerCorrectedIssue: number | null;
  expectedChangedParagraphIds: string[];
  actualChangedParagraphIds: string[];
  unexpectedParagraphChanges: string[];
  issues: IssueScore[];
  finalDocumentHtml: string;
  expectedDocumentHtml: string;
  judge?: CaseJudgeResult;
};

export type ScoreArtifact = {
  version: "v1";
  runId: string;
  createdAt: string;
  summary: {
    totalCases: number;
    exactDocumentMatches: number;
    casesWithFullIssueCoverage: number;
    totalIssues: number;
    correctedIssues: number;
    attemptedButInvalidIssues: number;
    notAddressedIssues: number;
    attemptedButInvalidRate: number | null;
    notAddressedRate: number | null;
    averageIssueCoverage: number;
    totalOutputTokens: number;
    averageOutputTokensPerCase: number;
    correctionsPerOutputToken: number;
    totalDurationMs: number;
    averageDurationMsPerCase: number;
    averageTurnsPerChunk: number | null;
    judge?: {
      judgeModel: string;
      casesPassed: number;
      casesWithNewErrors: number;
      unnecessaryChanges: number;
      collateralDamageCount: number;
      resolvedIssues: number;
      totalIssues: number;
      averageRestraintScore: number;
      averageResolvedIssuesPerUsd: number | null;
      averageQualityScore: number;
      averageBenchmarkScore: number;
    };
    axes?: RunAxesSummary;
    cost?: RunCostSummary;
    tooling?: RunToolingSummary;
  };
  cases: CaseScore[];
};

export type ResultsAttempt = {
  sessionId: string;
  recordedAt: string;
  model: string;
  baseModel: string;
  reasoningEffort: string | null;
  apiProvider: string | null;
  apiEndpointLabel: string | null;
  maxWordsPerChunk: number | null;
  maxTurnsPerChunk: number | null;
  datasetPath: string;
  datasetName: string;
  datasetHash: string;
  judgeModel: string | null;
  runNumber: number;
  succeeded: boolean;
  error: string | null;
  runId: string | null;
  runArtifact: string | null;
  reportArtifact: string | null;
  correctedIssues: number | null;
  attemptedButInvalidIssues: number | null;
  notAddressedIssues: number | null;
  attemptedButInvalidRate: number | null;
  notAddressedRate: number | null;
  totalIssues: number | null;
  fullIssueCoverageCases: number | null;
  totalCases: number | null;
  totalOutputTokens: number | null;
  totalDurationMs: number | null;
  averageTurnsPerChunk: number | null;
  correctionsPerOutputToken: number | null;
  judgePassedCases: number | null;
  judgeResolvedIssues: number | null;
  judgeTotalIssues: number | null;
  judgeUnnecessaryChanges: number | null;
  judgeCollateralDamage: number | null;
  judgeAverageRestraintScore: number | null;
  judgeAverageResolvedIssuesPerUsd: number | null;
  judgeAverageQualityScore: number | null;
  judgeAverageBenchmarkScore: number | null;
  qualityAxis: number | null;
  restraintAxis: number | null;
  efficiencyAxis: number | null;
  speedAxis: number | null;
  benchmarkToolCalls: number | null;
  benchmarkToolArgumentChars: number | null;
  offTargetToolCalls: number | null;
  offTargetToolArgumentChars: number | null;
  benchmarkToolCallsPerResolvedIssue: number | null;
  benchmarkToolCharsPerResolvedIssue: number | null;
  offTargetToolCharsShare: number | null;
  benchmarkParagraphRewriteShare: number | null;
  candidateCostUsd: number | null;
  judgeCostUsd: number | null;
  totalCostUsd: number | null;
};

export type ResultsDatasetSummary = {
  datasetPath: string;
  datasetName: string;
  datasetHash: string;
  attemptCount: number;
  succeededAttempts: number;
  failedAttempts: number;
  models: string[];
  judgeModels: string[];
};

export type ResultsAggregateRow = {
  model: string;
  baseModel: string;
  reasoningEffort: string | null;
  apiProvider: string | null;
  apiEndpointLabel: string | null;
  maxWordsPerChunk: number | null;
  maxTurnsPerChunk: number | null;
  datasetCount: number;
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  successRate: number;
  runIds: string[];
  runScoreSeries: Array<number | null>;
  runQualitySeries: Array<number | null>;
  meanCorrectedIssues: number | null;
  meanAttemptedButInvalidIssues: number | null;
  meanNotAddressedIssues: number | null;
  meanAttemptedButInvalidRate: number | null;
  meanNotAddressedRate: number | null;
  meanTotalIssues: number | null;
  meanFullIssueCoverageCases: number | null;
  meanTotalCases: number | null;
  meanTotalOutputTokens: number | null;
  meanTotalDurationMs: number | null;
  meanAverageTurnsPerChunk: number | null;
  meanCorrectionsPerOutputToken: number | null;
  meanJudgePassedCases: number | null;
  meanJudgeResolvedIssues: number | null;
  meanJudgeTotalIssues: number | null;
  meanJudgeUnnecessaryChanges: number | null;
  meanJudgeCollateralDamage: number | null;
  meanJudgeAverageRestraintScore: number | null;
  meanJudgeAverageResolvedIssuesPerUsd: number | null;
  meanJudgeAverageQualityScore: number | null;
  meanJudgeAverageBenchmarkScore: number | null;
  meanCandidateCostUsd: number | null;
  meanJudgeCostUsd: number | null;
  meanTotalCostUsd: number | null;
  qualityAxis: number | null;
  restraintAxis: number | null;
  efficiencyAxis: number | null;
  speedAxis: number | null;
  meanBenchmarkToolCalls: number | null;
  meanBenchmarkToolArgumentChars: number | null;
  meanOffTargetToolCalls: number | null;
  meanOffTargetToolArgumentChars: number | null;
  meanBenchmarkToolCallsPerResolvedIssue: number | null;
  meanBenchmarkToolCharsPerResolvedIssue: number | null;
  meanOffTargetToolCharsShare: number | null;
  meanBenchmarkParagraphRewriteShare: number | null;
  costAxisUsd: number | null;
  stabilityAxis: number;
  meanPerDatasetQualityRange: number | null;
  medianPerDatasetQualityRange: number | null;
  judgeAverageBenchmarkScoreRange: number | null;
  bestJudgeAverageBenchmarkScore: number | null;
  worstJudgeAverageBenchmarkScore: number | null;
};

export type ResultsArtifact = {
  version: "v1";
  groupId: string;
  createdAt: string;
  updatedAt: string;
  models: string[];
  judgeModels: string[];
  datasets: ResultsDatasetSummary[];
  attempts: ResultsAttempt[];
  aggregates: ResultsAggregateRow[];
  ranking: ResultsAggregateRow[];
};
