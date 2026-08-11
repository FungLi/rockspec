import { z } from "zod";
import { PROFILES, type WorkflowProfile } from "./constants.js";
import { ProtocolValidationError } from "./validation.js";

export const CHANGE_KINDS = [
  "copy",
  "style",
  "config",
  "feature",
  "fix",
  "security",
  "payment",
  "privacy",
  "migration",
  "infrastructure",
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const ChangeKindSchema = z.enum(CHANGE_KINDS);

export const HIGH_RISK_TAGS = [
  "security",
  "authentication",
  "authorization",
  "payment",
  "privacy",
  "compliance",
  "migration",
  "infrastructure",
  "public-api",
  "database",
  "data-format",
  "dependency",
  "concurrency",
  "cache-consistency",
  "irreversible",
] as const;

const HIGH_RISK = new Set<string>(HIGH_RISK_TAGS);
const PROFILE_RANK: Record<WorkflowProfile, number> = { lite: 0, standard: 1, strict: 2 };

export interface ProfileTriageInput {
  kind?: ChangeKind;
  requestedProfile?: WorkflowProfile | "auto";
  riskFactors?: readonly string[];
  riskTags?: readonly string[];
}

export interface TriageResult {
  profile: WorkflowProfile;
  minimumProfile: WorkflowProfile;
  promoted: boolean;
  reasons: string[];
  matched_risks: string[];
}

export type ProfileTriageResult = TriageResult;

export function profileRank(profile: WorkflowProfile): number {
  return PROFILE_RANK[profile];
}

export function canUseProfile(
  minimumProfile: WorkflowProfile,
  requestedProfile: WorkflowProfile,
): boolean {
  return profileRank(requestedProfile) >= profileRank(minimumProfile);
}

export function triageProfile(input: ProfileTriageInput = {}): TriageResult {
  const kind = input.kind ?? "feature";
  const suppliedRisks = [...(input.riskFactors ?? []), ...(input.riskTags ?? [])].map((tag) =>
    tag.trim().toLowerCase(),
  );
  const highRiskTags = [...new Set(suppliedRisks.filter((tag) => HIGH_RISK.has(tag)))];
  const matchedRisks = HIGH_RISK.has(kind)
    ? [...new Set([kind, ...highRiskTags])]
    : highRiskTags;
  let minimumProfile: WorkflowProfile;
  const reasons: string[] = [];

  if (HIGH_RISK.has(kind) || highRiskTags.length > 0) {
    minimumProfile = "strict";
    reasons.push(
      matchedRisks.length > 0
        ? `High-risk scope: ${matchedRisks.join(", ")}`
        : `High-risk change kind: ${kind}`,
    );
  } else if (kind === "copy" || kind === "style" || kind === "config") {
    minimumProfile = "lite";
    reasons.push(`Narrow ${kind} change`);
  } else {
    minimumProfile = "standard";
    reasons.push(`Behavioral change kind: ${kind}`);
  }

  const requestedProfile =
    input.requestedProfile === undefined || input.requestedProfile === "auto"
      ? minimumProfile
      : input.requestedProfile;
  if (!canUseProfile(minimumProfile, requestedProfile)) {
    throw new ProtocolValidationError("Requested workflow profile is below the minimum", [
      {
        code: "profile_downgrade_forbidden",
        path: ["requestedProfile"],
        message: `${kind} requires ${minimumProfile} or higher; ${requestedProfile} is not allowed`,
      },
    ]);
  }

  if (requestedProfile !== minimumProfile) {
    reasons.push(`Explicitly promoted to ${requestedProfile}`);
  }
  return {
    profile: requestedProfile,
    minimumProfile,
    promoted: profileRank(requestedProfile) > profileRank(minimumProfile),
    reasons,
    matched_risks: matchedRisks,
  };
}

export const ProfileSchema = z.enum(PROFILES);
