export const CAPABILITY_IDS = ["ui.prototype"] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilityBinding {
  provider: string;
  distribution?: "bundled" | "installed" | "host";
}

export interface CapabilityConfig {
  capabilities: Record<string, CapabilityBinding>;
}

export interface ResolvedCapability {
  id: string;
  provider: string;
  distribution: "bundled" | "installed" | "host";
  available: boolean;
  reason?: string;
}

export const DEFAULT_CAPABILITIES: CapabilityConfig = {
  capabilities: {
    "ui.prototype": {
      provider: "ui-ux-pro-max",
      distribution: "installed",
    },
  },
};

export function resolveCapability(
  id: string,
  config: CapabilityConfig,
  availableProviders: ReadonlySet<string> = new Set(),
): ResolvedCapability {
  const binding = config.capabilities[id];
  if (!binding) {
    return {
      id,
      provider: "",
      distribution: "installed",
      available: false,
      reason: `No provider is configured for capability ${id}`,
    };
  }

  const distribution = binding.distribution ?? "installed";
  const available = distribution === "bundled" || availableProviders.has(binding.provider);
  return {
    id,
    provider: binding.provider,
    distribution,
    available,
    ...(available ? {} : { reason: `Provider ${binding.provider} is not available in this host` }),
  };
}
