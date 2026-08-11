import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const mode = process.argv[2];
const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");

if (mode === "skills") {
  const validator = path.join(
    codexHome,
    "skills",
    ".system",
    "skill-creator",
    "scripts",
    "quick_validate.py",
  );
  requireValidator(validator);
  const skills = readdirSync("skills", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join("skills", entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  for (const skill of skills) run(validator, path.join("skills", skill));
} else if (mode === "plugin") {
  const validator = path.join(
    codexHome,
    "skills",
    ".system",
    "plugin-creator",
    "scripts",
    "validate_plugin.py",
  );
  requireValidator(validator);
  run(validator, ".");
} else {
  process.stderr.write("Usage: node scripts/validate-authoring.mjs <skills|plugin>\n");
  process.exitCode = 2;
}

function requireValidator(validator) {
  if (!existsSync(validator)) {
    throw new Error(`Official authoring validator not found: ${validator}`);
  }
}

function run(validator, target) {
  const result = spawnSync("python3", [validator, target], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
