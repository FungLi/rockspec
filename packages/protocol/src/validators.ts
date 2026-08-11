import { z } from "zod";
import {
  EvidenceSchema,
  ReviewSchema,
  TaskRecordSchema,
  type Evidence,
  type Review,
  type TaskRecord,
} from "./schemas.js";
import { safeParseProtocol, type ValidationIssue, type ValidationResult } from "./validation.js";

export const TaskCommitSchema = z
  .object({
    task_id: z.string().regex(/^T-\d{3,}$/),
    commit_sha: z.string().regex(/^[a-f0-9]{7,64}$/i),
    message: z.string().min(1),
  })
  .strict()
  .superRefine((commit, context) => {
    if (!commit.message.includes(`[${commit.task_id}]`)) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: `Commit message must contain [${commit.task_id}]`,
      });
    }
  });

export type TaskCommit = z.infer<typeof TaskCommitSchema>;

export function validateReview(input: unknown): ValidationResult<Review> {
  return safeParseProtocol(ReviewSchema, input);
}

export function validateEvidence(input: unknown): ValidationResult<Evidence> {
  return safeParseProtocol(EvidenceSchema, input);
}

export function validateTaskCommit(
  taskInput: unknown,
  commitMessage?: string,
): ValidationResult<TaskRecord> {
  const taskResult = safeParseProtocol(TaskRecordSchema, taskInput);
  if (!taskResult.valid) return taskResult;

  const issues: ValidationIssue[] = [];
  const task = taskResult.data;
  if (task.status === "completed") {
    if (task.commit_sha === undefined) {
      issues.push({
        code: "missing_task_commit",
        path: ["commit_sha"],
        message: "A completed task must have exactly one final commit",
      });
    }
    if (commitMessage === undefined || !commitMessage.includes(`[${task.id}]`)) {
      issues.push({
        code: "missing_task_id_in_commit",
        path: ["commit_message"],
        message: `Task commit message must contain [${task.id}]`,
      });
    }
  }

  return issues.length === 0
    ? { valid: true, data: task, issues: [] }
    : { valid: false, issues };
}

export function validateUniqueTaskCommits(tasks: readonly TaskRecord[]): ValidationResult<TaskRecord[]> {
  const seen = new Map<string, string>();
  const issues: ValidationIssue[] = [];
  for (const task of tasks) {
    if (task.commit_sha === undefined) continue;
    const owner = seen.get(task.commit_sha);
    if (owner !== undefined && owner !== task.id) {
      issues.push({
        code: "task_commit_reused",
        path: [task.id, "commit_sha"],
        message: `Commit ${task.commit_sha} is already owned by ${owner}`,
      });
    } else {
      seen.set(task.commit_sha, task.id);
    }
  }
  return issues.length === 0
    ? { valid: true, data: [...tasks], issues: [] }
    : { valid: false, issues };
}
