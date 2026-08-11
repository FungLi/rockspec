import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { InstallHost } from "@rockspec/protocol";
import { InstallerError, installProject, type InstallProjectResult } from "@rockspec/installer";

interface WizardDefaults {
  cwd?: string;
  sourceRoot?: string;
}

export async function runInstallWizard(defaults: WizardDefaults = {}): Promise<InstallProjectResult> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new InstallerError(
      "INTERACTIVE_REQUIRED",
      "Interactive installation requires a TTY; use install --yes with explicit options",
    );
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("\nRockSpec Installer\n\n");
    const projectInput = await prompt.question(`Project directory [${defaults.cwd ?? process.cwd()}]: `);
    const projectRoot = projectInput.trim() || defaults.cwd || process.cwd();
    const hostsInput = await prompt.question("Hosts (codex,claude) [codex,claude]: ");
    const hosts = parseHosts(hostsInput.trim() || "codex,claude");
    const prototypeInput = await prompt.question("Install UI prototype capability and ui-ux-pro-max? [Y/n]: ");
    const withPrototype = !/^n(?:o)?$/i.test(prototypeInput.trim());
    let acceptUnknownLicense = false;
    let prototypeSource: string | undefined;
    if (withPrototype) {
      const licenseInput = await prompt.question("ui-ux-pro-max has no verified License metadata. Copy the locally installed Skill? [y/N]: ");
      acceptUnknownLicense = /^y(?:es)?$/i.test(licenseInput.trim());
      if (!acceptUnknownLicense) {
        throw new InstallerError("EXTERNAL_LICENSE_UNCONFIRMED", "Installation cancelled because the external Skill license was not accepted");
      }
      const sourceInput = await prompt.question("ui-ux-pro-max source path [auto-discover in user Skill roots]: ");
      prototypeSource = sourceInput.trim() || undefined;
    }
    const externalSkills = prototypeSource ? { "ui-ux-pro-max": prototypeSource } : undefined;
    const plan = await installProject({
      projectRoot,
      hosts,
      ...(defaults.sourceRoot ? { sourceRoot: defaults.sourceRoot } : {}),
      ...(withPrototype ? {
        withCapabilities: ["ui.prototype"],
        acceptUnknownLicense,
        ...(externalSkills ? { externalSkills } : {}),
      } : { withoutCapabilities: ["ui.prototype"] }),
      dryRun: true,
    });
    stdout.write("\nPlanned changes:\n");
    for (const item of plan.plan) stdout.write(`  ${item.action.padEnd(7)} ${item.path}\n`);
    const confirmation = await prompt.question("\nInstall RockSpec? [Y/n]: ");
    if (/^n(?:o)?$/i.test(confirmation.trim())) {
      throw new InstallerError("INSTALL_CANCELLED", "Installation cancelled by the user");
    }
    return installProject({
      projectRoot,
      hosts,
      ...(defaults.sourceRoot ? { sourceRoot: defaults.sourceRoot } : {}),
      ...(withPrototype ? {
        withCapabilities: ["ui.prototype"],
        acceptUnknownLicense,
        ...(externalSkills ? { externalSkills } : {}),
      } : { withoutCapabilities: ["ui.prototype"] }),
    });
  } finally {
    prompt.close();
  }
}

function parseHosts(value: string): InstallHost[] {
  const hosts = value.split(",").map((host) => host.trim()).filter(Boolean);
  for (const host of hosts) {
    if (host !== "codex" && host !== "claude") {
      throw new InstallerError("INVALID_HOST", `Unknown host ${host}`, { allowed: ["codex", "claude"] });
    }
  }
  return [...new Set(hosts)] as InstallHost[];
}
