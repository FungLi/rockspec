import { z } from "zod";
import { RESERVED_CHANGE_IDS } from "./constants.js";
import { parseProtocol } from "./validation.js";

const CHANGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED = new Set<string>(RESERVED_CHANGE_IDS);

export const ChangeIdSchema = z
  .string()
  .min(3, "Change ID must contain at least 3 characters")
  .max(64, "Change ID must contain at most 64 characters")
  .regex(
    CHANGE_ID_PATTERN,
    "Change ID must be lowercase kebab-case, start with a letter, and contain only ASCII letters and digits",
  )
  .refine((value) => !RESERVED.has(value), "Change ID is reserved")
  .brand<"ChangeId">();

export type ChangeId = z.infer<typeof ChangeIdSchema>;

export function validateChangeId(value: string): value is ChangeId {
  return ChangeIdSchema.safeParse(value).success;
}

export function assertChangeId(value: string): asserts value is ChangeId {
  parseProtocol(ChangeIdSchema, value, "change ID");
}
