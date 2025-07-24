import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";
import { GatewayIdentity, Address } from "../../core/types";
import { LedgerType } from "@hyperledger/cactus-core-api";

export interface KademliaGatewayInfo {
  blockchainId: string;
  nodeId: number;
  endpoint: string;
  supportedProtocols: string[];
  timestamp: number;
  chainId?: number;
  isHealthy?: boolean;
  lastHealthCheck?: number;
  age: string;
  isFresh: boolean;
  hasRecentHealthCheck: boolean;
}

export interface KademliaDiscoveryResponse {
  blockchainId: string;
  gateways: KademliaGatewayInfo[];
  count: number;
  totalFound: number;
  filtered: number;
  searchedFrom: {
    nodeId: number;
    httpPort: number;
    udpPort: number;
  };
  encrypted: boolean;
  encryptionCoverage: string;
  filters: {
    includeUnhealthy: boolean;
    maxAge: string;
  };
  message: string;
  timestamp: number;
}

export interface KademliaGatewayDiscoveryOptions {
  kademliaNodes: string[]; // Array of Kademlia node URLs like "http://localhost:2000"
  logLevel?: LogLevelDesc;
  requestTimeout?: number;
  includeUnhealthy?: boolean;
  maxAge?: number; // in minutes
  useSecure?: boolean; // Use secure endpoints
}

export class KademliaGatewayDiscoveryService {
  public static readonly CLASS_NAME = "KademliaGatewayDiscoveryService";
  private readonly log: Logger;
  private readonly options: KademliaGatewayDiscoveryOptions;

  constructor(options: KademliaGatewayDiscoveryOptions) {
    this.options = {
      requestTimeout: 5000,
      includeUnhealthy: false,
      maxAge: 60, // 1 hour default
      useSecure: true,
      ...options,
    };

    const label = KademliaGatewayDiscoveryService.CLASS_NAME;
    this.log = LoggerProvider.getOrCreate({
      label,
      level: this.options.logLevel || "INFO",
    });
  }

  /**
   * Discovers gateways for a specific blockchain by querying Kademlia nodes
   * 
   * @param blockchainId The blockchain identifier to search for
   * @returns Array of discovered gateway identities
   */
  public async discoverGateways(blockchainId: string): Promise<GatewayIdentity[]> {
    const fnTag = `${KademliaGatewayDiscoveryService.CLASS_NAME}#discoverGateways()`;
    this.log.info(`${fnTag} Searching for gateways supporting blockchain: ${blockchainId}`);

    const discoveredGateways: GatewayIdentity[] = [];
    const errors: string[] = [];

    // Try each Kademlia node until we find gateways or exhaust all nodes
    for (const nodeUrl of this.options.kademliaNodes) {
      try {
        this.log.debug(`${fnTag} Querying Kademlia node: ${nodeUrl}`);
        
        const gateways = await this.queryKademliaNode(nodeUrl, blockchainId);
        
        if (gateways.length > 0) {
          this.log.info(`${fnTag} Found ${gateways.length} gateway(s) from node ${nodeUrl}`);
          
          // Convert Kademlia gateway info to SATP Gateway Identity
          for (const kademliaGateway of gateways) {
            const gatewayIdentity = this.convertToGatewayIdentity(kademliaGateway, blockchainId);
            if (gatewayIdentity && !this.isDuplicateGateway(discoveredGateways, gatewayIdentity)) {
              discoveredGateways.push(gatewayIdentity);
            }
          }
        }
      } catch (error) {
        const errorMsg = `Failed to query node ${nodeUrl}: ${error.message}`;
        this.log.warn(`${fnTag} ${errorMsg}`);
        errors.push(errorMsg);
        continue; // Try next node
      }
    }

    if (discoveredGateways.length === 0) {
      this.log.warn(`${fnTag} No gateways found for blockchain ${blockchainId}`);
      this.log.warn(`${fnTag} Errors encountered: ${JSON.stringify(errors)}`);
    } else {
      this.log.info(`${fnTag} Successfully discovered ${discoveredGateways.length} gateway(s) for blockchain ${blockchainId}`);
    }

    return discoveredGateways;
  }

  /**
   * Queries a single Kademlia node for gateways
   */
  private async queryKademliaNode(
    nodeUrl: string, 
    blockchainId: string
  ): Promise<KademliaGatewayInfo[]> {
    const endpoint = this.options.useSecure ? 'secure/findGateway' : 'findGateway';
    const url = `${nodeUrl}/${endpoint}/${encodeURIComponent(blockchainId)}`;
    
    // Build query parameters
    const params = new URLSearchParams();
    if (this.options.includeUnhealthy !== undefined) {
      params.append('includeUnhealthy', this.options.includeUnhealthy.toString());
    }
    if (this.options.maxAge !== undefined) {
      params.append('maxAge', this.options.maxAge.toString());
    }
    
    const fullUrl = params.toString() ? `${url}?${params.toString()}` : url;

    this.log.debug(`Making request to: ${fullUrl}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.options.requestTimeout);

    try {
      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: KademliaDiscoveryResponse = await response.json();
      
      this.log.debug(`Received response from ${nodeUrl}:`, {
        found: data.count,
        encrypted: data.encrypted,
        message: data.message
      });

      return data.gateways || [];

    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.options.requestTimeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Converts Kademlia gateway info to SATP Gateway Identity
   */
  private convertToGatewayIdentity(
    kademliaGateway: KademliaGatewayInfo, 
    blockchainId: string
  ): GatewayIdentity | null {
    try {
      // Extract port from endpoint if possible
      let gatewayPort = 3000; // default
      let address: string;
      
      try {
        const url = new URL(kademliaGateway.endpoint);
        gatewayPort = parseInt(url.port) || 3000;
        
        // Build address according to Address type format
        // Address type: `http://${string}` | `https://${string}` | `${number}.${number}.${number}.${number}`
        const protocol = url.protocol.replace(':', ''); // Remove the colon
        const hostname = url.hostname;
        
        // Check if hostname is an IP address
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (ipRegex.test(hostname)) {
          // It's an IP address, use IP format
          address = hostname;
        } else {
          // It's a hostname, use protocol://hostname format
          address = `${protocol}://${hostname}` as Address;
        }
      } catch (error) {
        this.log.warn(`Could not parse gateway endpoint ${kademliaGateway.endpoint}, using default values`);
        // Fallback to localhost
        address = "http://localhost";
        gatewayPort = 3000;
      }

      // Map blockchain ID to LedgerType
      const ledgerType = this.mapBlockchainIdToLedgerType(blockchainId);

      const gatewayIdentity: GatewayIdentity = {
        id: `kademlia-gateway-${kademliaGateway.nodeId}`,
        name: `Gateway-${kademliaGateway.nodeId}`,
        version: [
          {
            Core: "1.0.0",
            Architecture: "1.0.0", 
            Crash: "1.0.0",
          },
        ],
        connectedDLTs: [
          {
            id: blockchainId,
            ledgerType: ledgerType,
          },
        ],
        proofID: `kademlia-proof-${kademliaGateway.nodeId}`,
        gatewayServerPort: gatewayPort,
        gatewayClientPort: gatewayPort + 1000,
        address: address as Address,
      };

      return gatewayIdentity;
    } catch (error) {
      this.log.error(`Failed to convert Kademlia gateway to SATP format: ${error.message}`);
      return null;
    }
  }

  /**
   * Maps blockchain identifiers to LedgerType enum values
   */
  private mapBlockchainIdToLedgerType(blockchainId: string): LedgerType {
    const blockchainIdLower = blockchainId.toLowerCase();
    
    if (blockchainIdLower.includes('besu')) {
      return LedgerType.Besu2X;
    }
    if (blockchainIdLower.includes('fabric')) {
      return LedgerType.Fabric2;
    }
    if (blockchainIdLower.includes('ethereum') || blockchainIdLower.includes('eth')) {
      return LedgerType.Ethereum;
    }
    
    // Default fallback - you might want to make this configurable
    this.log.warn(`Unknown blockchain type: ${blockchainId}, defaulting to Besu2X`);
    return LedgerType.Besu2X;
  }

  /**
   * Checks if a gateway is already in the discovered list
   */
  private isDuplicateGateway(
    existingGateways: GatewayIdentity[], 
    newGateway: GatewayIdentity
  ): boolean {
    return existingGateways.some(existing => 
      existing.id === newGateway.id || 
      (existing.address === newGateway.address && 
       existing.gatewayServerPort === newGateway.gatewayServerPort)
    );
  }

  /**
   * Health check discovered gateways by pinging their endpoints
   */
  public async healthCheckGateways(gateways: GatewayIdentity[]): Promise<GatewayIdentity[]> {
    const fnTag = `${KademliaGatewayDiscoveryService.CLASS_NAME}#healthCheckGateways()`;
    this.log.info(`${fnTag} Health checking ${gateways.length} discovered gateway(s)`);

    const healthyGateways: GatewayIdentity[] = [];

    for (const gateway of gateways) {
      try {
        const isHealthy = await this.pingGateway(gateway);
        if (isHealthy) {
          healthyGateways.push(gateway);
          this.log.debug(`${fnTag} Gateway ${gateway.id} is healthy`);
        } else {
          this.log.warn(`${fnTag} Gateway ${gateway.id} failed health check`);
        }
      } catch (error) {
        this.log.warn(`${fnTag} Error health checking gateway ${gateway.id}: ${error.message}`);
      }
    }

    this.log.info(`${fnTag} ${healthyGateways.length}/${gateways.length} gateways passed health check`);
    return healthyGateways;
  }

  /**
   * Simple ping to check if gateway is responding
   */
  private async pingGateway(gateway: GatewayIdentity): Promise<boolean> {
    try {
      const url = `${gateway.address}:${gateway.gatewayServerPort}/health`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get configuration summary
   */
  public getConfig(): Readonly<KademliaGatewayDiscoveryOptions> {
    return { ...this.options };
  }
}