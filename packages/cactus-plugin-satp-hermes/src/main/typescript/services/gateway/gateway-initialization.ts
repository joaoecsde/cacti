import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { initializeGatewayResolver } from "../network-identification/resolve-gateway";
import { EnhancedGatewayResolverOptions } from "../network-identification/resolve-kademlia-gateway";

export interface KademliaDiscoveryConfig {
  enabled: boolean;
  nodes: string[]; // e.g., ["http://localhost:2000", "http://localhost:2001"]
  requestTimeout?: number;
  includeUnhealthy?: boolean;
  maxAge?: number;
  useSecure?: boolean;
}

export interface GatewayInitializationConfig {
  kademliaDiscovery?: KademliaDiscoveryConfig;
  logLevel?: LogLevelDesc;
}

/**
 * Initialize the SATP Gateway with Kademlia discovery support
 * This should be called during gateway startup
 */
export function initializeGatewayWithKademliaDiscovery(config: GatewayInitializationConfig): void {
  const logger = LoggerProvider.getOrCreate({
    label: "GatewayInitialization",
    level: config.logLevel || "INFO",
  });

  logger.info("Initializing SATP Gateway with Kademlia discovery...");

  // Prepare resolver options
  const resolverOptions: EnhancedGatewayResolverOptions = {
    logLevel: config.logLevel,
    cacheTimeout: 300000, // 5 minutes
  };

  // Configure Kademlia discovery if enabled
  if (config.kademliaDiscovery?.enabled && config.kademliaDiscovery.nodes.length > 0) {
    resolverOptions.kademliaDiscovery = {
      enabled: true,
      nodes: config.kademliaDiscovery.nodes,
      requestTimeout: config.kademliaDiscovery.requestTimeout || 5000,
      includeUnhealthy: config.kademliaDiscovery.includeUnhealthy || false,
      maxAge: config.kademliaDiscovery.maxAge || 60,
      useSecure: config.kademliaDiscovery.useSecure !== false, // default to true
    };

    logger.info(`Kademlia discovery enabled with nodes: ${config.kademliaDiscovery.nodes.join(", ")}`);
  } else {
    resolverOptions.kademliaDiscovery = {
      enabled: false,
      nodes: [],
    };

    logger.info("Kademlia discovery disabled, using static gateways only");
  }

  // Initialize the global resolver
  initializeGatewayResolver(resolverOptions);

  logger.info("Gateway initialization completed successfully");
}

/**
 * Example configuration for development/testing
 */
export function getExampleKademliaConfig(): GatewayInitializationConfig {
  return {
    kademliaDiscovery: {
      enabled: true,
      nodes: [
        "http://localhost:2000", // Node 0
        "http://localhost:2001", // Node 1  
        "http://localhost:2002", // Node 2
      ],
      requestTimeout: 5000,
      includeUnhealthy: false,
      maxAge: 60, // 1 hour
      useSecure: true, // Use secure encrypted endpoints
    },
    logLevel: "DEBUG",
  };
}