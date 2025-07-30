import { LedgerType } from "@hyperledger/cactus-core-api";
import { GatewayIdentity } from "../../core/types";
import { Logger } from "@hyperledger/cactus-common";
import { EnhancedGatewayResolver, EnhancedGatewayResolverOptions } from "./resolve-kademlia-gateway";

// Global resolver instance (initialized once)
let globalResolver: EnhancedGatewayResolver | null = null;

/**
 * Initialize the gateway resolver with Kademlia discovery configuration
 * This should be called once during gateway startup
 */
export function initializeGatewayResolver(options: EnhancedGatewayResolverOptions): void {
  globalResolver = new EnhancedGatewayResolver(options);
}

/**
 * Get the current resolver instance
 */
export function getGatewayResolver(): EnhancedGatewayResolver {
  if (!globalResolver) {
    // Fallback to static-only resolver if not initialized
    globalResolver = new EnhancedGatewayResolver({
      kademliaDiscovery: { enabled: false, nodes: [] },
    });
  }
  return globalResolver;
}

// NEW FUNCTION - for blockchain-based discovery
export async function resolveGatewaysByBlockchain(
  logger: Logger,
  blockchainId: string,
): Promise<GatewayIdentity[]> {
  const fnTag = `#resolveGatewaysByBlockchain()`;
  logger.trace(`Entering ${fnTag}`);
  logger.info(`Resolving gateways for blockchain: ${blockchainId}`);

  try {
    const resolver = getGatewayResolver();
    const gateways = await resolver.resolveGatewaysByBlockchain(blockchainId);
    
    if (gateways.length === 0) {
      logger.warn(`${fnTag} No gateways found for blockchain: ${blockchainId}`);
    } else {
      logger.info(`${fnTag} Found ${gateways.length} gateway(s) for blockchain: ${blockchainId}`);
    }
    
    return gateways;
  } catch (error) {
    logger.error(`${fnTag} Failed to resolve gateways for blockchain ${blockchainId}: ${error.message}`);
    throw error;
  }
}

// gets an ID, queries a repository, returns a gateway identity
export async function resolveGatewayID(
  logger: Logger,
  ID: string,
): Promise<GatewayIdentity> {
  const fnTag = `#resolveGatewayID()`;
  logger.trace(`Entering ${fnTag}`);
  logger.info(`Resolving gateway with ID: ${ID}`);

  const mockGatewayIdentity: GatewayIdentity[] = [
    {
      id: "1",
      name: "Gateway1",
      version: [
        {
          Core: "1.0",
          Architecture: "1.0",
          Crash: "1.0",
        },
      ],
      connectedDLTs: [
        { id: "BESU", ledgerType: LedgerType.Besu2X },
        { id: "FABRIC", ledgerType: LedgerType.Fabric2 },
        { id: "ETH", ledgerType: LedgerType.Ethereum },
      ],
      proofID: "mockProofID1",
      gatewayServerPort: 3011,
      address: "http://localhost",
    },
    {
      id: "2",
      name: "Gateway2",
      version: [
        {
          Core: "1.0",
          Architecture: "1.0",
          Crash: "1.0",
        },
      ],
      connectedDLTs: [
        { id: "BESU", ledgerType: LedgerType.Besu2X },
        { id: "FABRIC", ledgerType: LedgerType.Fabric2 },
        { id: "ETH", ledgerType: LedgerType.Ethereum },
      ],
      proofID: "mockProofID1",
      gatewayServerPort: 3012,
      address: "http://localhost",
    },
  ];
  return mockGatewayIdentity.filter((gateway) => gateway.id === ID)[0];
}

// TODO! dummy implementation for testing; contains hardcoded gateways similar to Bitcoin seeds
export function getGatewaySeeds(logger: Logger): GatewayIdentity[] {
  const fnTag = `#getGatewaySeeds()`;
  logger.trace(`Entering ${fnTag}`);
  return [];
}
