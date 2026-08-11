import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const root = process.cwd();
const releaseRoot = path.join(root, "packages", "cli", "release");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const installManifest = parse(await readFile(path.join(root, "distribution", "install-manifest.yaml"), "utf8"));
if (installManifest.rockspec?.version !== rootPackage.version) {
  throw new Error(`Install Manifest version ${installManifest.rockspec?.version ?? "missing"} does not match package version ${rootPackage.version}`);
}
const skillDirectories = (await readdir(path.join(root, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("rockspec-"))
  .map((entry) => entry.name)
  .sort();
const declaredSkills = [...(installManifest.rockspec?.skills ?? [])].sort();
if (JSON.stringify(skillDirectories) !== JSON.stringify(declaredSkills)) {
  throw new Error("Install Manifest Skill list does not match the canonical skills directory");
}

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
await cp(path.join(root, "distribution"), path.join(releaseRoot, "distribution"), { recursive: true });
await cp(path.join(root, "skills"), path.join(releaseRoot, "skills"), { recursive: true });
await cp(path.join(root, "README.md"), path.join(releaseRoot, "README.md"));
await cp(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(releaseRoot, "THIRD_PARTY_NOTICES.md"));

const releasePackage = {
  name: "@rockspec/cli",
  version: rootPackage.version,
  description: "Project installer and deterministic Harness Engineering CLI for RockSpec",
  type: "module",
  bin: {
    rockspec: "./distribution/runtime/rockspec.mjs",
  },
  files: [
    "distribution/",
    "skills/",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
  ],
  engines: {
    node: ">=20.19.0",
  },
  publishConfig: {
    access: "public",
  },
  license: rootPackage.license,
};

await writeFile(path.join(releaseRoot, "package.json"), `${JSON.stringify(releasePackage, null, 2)}\n`);
