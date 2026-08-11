import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RockSpecError } from "./error.js";
import { exists, walkFiles } from "./storage.js";

export function sha256(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function hashPaths(
  changeDir: string,
  relativePaths: readonly string[],
): Promise<{ artifact_hashes: Record<string, string>; aggregate_hash: string }> {
  const paths = new Set<string>();
  for (const relativePath of relativePaths) {
    const absolute = path.join(changeDir, relativePath);
    if (!(await exists(absolute))) {
      throw new RockSpecError("MISSING_ARTIFACT", `Required artifact ${relativePath} does not exist`, {
        path: relativePath,
      });
    }
    const files = await walkFiles(absolute);
    if (files.length === 0) paths.add(relativePath);
    else for (const file of files) paths.add(path.relative(changeDir, file));
  }

  const artifactHashes: Record<string, string> = {};
  for (const relativePath of [...paths].sort()) {
    const absolute = path.join(changeDir, relativePath);
    if (!(await exists(absolute))) continue;
    try {
      artifactHashes[relativePath] = sha256(await readFile(absolute));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EISDIR") throw error;
    }
  }
  if (Object.keys(artifactHashes).length === 0) {
    throw new RockSpecError("EMPTY_ARTIFACT_SET", "Approval content contains no files", {
      paths: relativePaths,
    });
  }
  const canonical = Object.entries(artifactHashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, hash]) => `${name}\0${hash}\n`)
    .join("");
  return { artifact_hashes: artifactHashes, aggregate_hash: sha256(canonical) };
}

export function approvalPaths(
  gate: "spec" | "design" | "implementation",
  prototypeRequired: boolean,
): string[] {
  if (gate === "spec") return ["proposal.md", "specs"];
  if (gate === "design") {
    return prototypeRequired ? ["design.md", "prototype"] : ["design.md"];
  }
  return ["design.md", "plan.md", "tasks.md", "tasks"];
}
