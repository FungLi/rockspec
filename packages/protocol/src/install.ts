import { z } from "zod";

export const InstallHostSchema = z.enum(["codex", "claude"]);
export type InstallHost = z.infer<typeof InstallHostSchema>;

const RelativeInstallPathSchema = z.string().min(1).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
  "Install paths must be repository-relative POSIX paths",
);

const IntegritySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const InstallManifestSchema = z.object({
  schema_version: z.literal(1),
  rockspec: z.object({
    version: z.string().min(1),
    runtime: RelativeInstallPathSchema,
    skills: z.array(z.string().regex(/^rockspec-[a-z0-9-]+$/)).min(1),
  }).strict(),
  capabilities: z.record(z.string().min(1), z.object({
    provider: z.string().min(1),
    default: z.boolean().default(false),
  }).strict()).default({}),
  external_skills: z.record(z.string().min(1), z.object({
    capability: z.string().min(1),
    source: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("local-discovery"),
        candidates: z.array(RelativeInstallPathSchema).min(1),
      }).strict(),
      z.object({
        type: z.literal("git"),
        repository: z.string().url(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        subdirectory: RelativeInstallPathSchema,
        integrity: IntegritySchema,
      }).strict(),
    ]),
    license: z.string().min(1),
    hosts: z.array(InstallHostSchema).min(1),
  }).strict()).default({}),
}).strict();

export type InstallManifest = z.infer<typeof InstallManifestSchema>;

export const ManagedInstallPathSchema = z.object({
  path: RelativeInstallPathSchema,
  kind: z.enum(["file", "directory", "symlink"]),
  integrity: IntegritySchema,
}).strict();

export const InstalledSkillSchema = z.object({
  name: z.string().min(1),
  owner: z.enum(["rockspec", "external"]),
  capability: z.string().min(1).optional(),
  source_type: z.enum(["bundled", "local", "git"]),
  source_ref: z.string().min(1),
  license: z.string().min(1),
  integrity: IntegritySchema,
  canonical_path: RelativeInstallPathSchema,
}).strict();

export const InstallLockSchema = z.object({
  schema_version: z.literal(1),
  rockspec: z.object({
    version: z.string().min(1),
    runtime_path: RelativeInstallPathSchema,
    integrity: IntegritySchema,
  }).strict(),
  installed_at: z.string().datetime({ offset: true }),
  hosts: z.partialRecord(InstallHostSchema, z.object({
    skills_root: RelativeInstallPathSchema,
    mode: z.enum(["canonical", "symlink", "copy"]),
  }).strict()),
  skills: z.record(z.string().min(1), InstalledSkillSchema),
  managed_paths: z.array(ManagedInstallPathSchema),
}).strict();

export type InstallLock = z.infer<typeof InstallLockSchema>;
export type ManagedInstallPath = z.infer<typeof ManagedInstallPathSchema>;
