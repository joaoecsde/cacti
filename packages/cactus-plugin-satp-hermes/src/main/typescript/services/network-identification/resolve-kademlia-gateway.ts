// services/discovery/enhanced-resolve-gateway.ts

import { GatewayIdentity } from "../../core/types";
import { Logger, LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { 
  KademliaGatewayDiscoveryService, 
} from "./kademlia-gateway-discovery";

export interface EnhancedGatewayResolverOptions {
  // Kademlia discovery options
  kademliaDiscovery?: {
    enabled: boolean;
    nodes: string[];
    requestTimeout?: number;
    includeUnhealthy?: boolean;
    maxAge?: number;
    useSecure?: boolean;
  };
  
  // Fallback to static gateways if Kademlia discovery fails
  staticGateways?: GatewayIdentity[];
  
  // Cache discovered gateways for this duration (in ms)
  cacheTimeout?: number;
  
  logLevel?: LogLevelDesc;
}

interface CachedGateway {
  gateway: GatewayIdentity;
  discoveredAt: number;
}

/**
 * Enhanced gateway resolver that combines Kademlia network discovery 
 * with fallback to static gateways
 */
export class EnhancedGatewayResolver {
  public static readonly CLASS_NAME = "EnhancedGatewayResolver";
  private readonly log: Logger;
  private readonly options: EnhancedGatewayResolverOptions;
  private readonly kademliaDiscovery?: KademliaGatewayDiscoveryService;
  
  // Cache for discovered gateways by blockchain ID
  private readonly gatewayCache = new Map<string, CachedGateway[]>();

  constructor(options: EnhancedGatewayResolverOptions) {
    this.options = {
      cacheTimeout: 300000, // 5 minutes default
      staticGateways: [],
      ...options,
    };

    const label = EnhancedGatewayResolver.CLASS_NAME;
    this.log = LoggerProvider.getOrCreate({
      label,
      level: this.options.logLevel || "INFO",
    });

    // Initialize Kademlia discovery service if enabled
    if (this.options.kademliaDiscovery?.enabled && this.options.kademliaDiscovery.nodes.length > 0) {
      this.kademliaDiscovery = new KademliaGatewayDiscoveryService({
        kademliaNodes: this.options.kademliaDiscovery.nodes,
        logLevel: this.options.logLevel,
        requestTimeout: this.options.kademliaDiscovery.requestTimeout,
        includeUnhealthy: this.options.kademliaDiscovery.includeUnhealthy,
        maxAge: this.options.kademliaDiscovery.maxAge,
        useSecure: this.options.kademliaDiscovery.useSecure,
      });
      
      this.log.info(`Kademlia discovery enabled with ${this.options.kademliaDiscovery.nodes.length} node(s)`);
    } else {
      this.log.info("Kademlia discovery disabled, using static gateways only");
    }
  }

  /**
   * Enhanced gateway resolution with multiple strategies:
   * 1. Check cache first
   * 2. Try Kademlia network discovery
   * 3. Fallback to static gateways
   * 4. Health check discovered gateways
   */
  public async resolveGatewaysByBlockchain(blockchainId: string): Promise<GatewayIdentity[]> {
    const fnTag = `${EnhancedGatewayResolver.CLASS_NAME}#resolveGatewaysByBlockchain()`;
    this.log.info(`${fnTag} Resolving gateways for blockchain: ${blockchainId}`);

    try {
      // Step 1: Check cache first
      const cachedGateways = this.getCachedGateways(blockchainId);
      if (cachedGateways.length > 0) {
        this.log.info(`${fnTag} Found ${cachedGateways.length} cached gateway(s) for ${blockchainId}`);
        return cachedGateways;
      }

      // Step 2: Try Kademlia discovery
      let discoveredGateways: GatewayIdentity[] = [];
      
      if (this.kademliaDiscovery) {
        this.log.info(`${fnTag} Attempting Kademlia discovery for ${blockchainId}`);
        try {
          discoveredGateways = await this.kademliaDiscovery.discoverGateways(blockchainId);
          
          if (discoveredGateways.length > 0) {
            this.log.info(`${fnTag} Kademlia discovery found ${discoveredGateways.length} gateway(s)`);
            
            // Health check discovered gateways
            const healthyGateways = await this.kademliaDiscovery.healthCheckGateways(discoveredGateways);
            
            if (healthyGateways.length > 0) {
              this.cacheGateways(blockchainId, healthyGateways);
              return healthyGateways;
            } else {
              this.log.warn(`${fnTag} No healthy gateways found via Kademlia, trying fallback`);
            }
          }
        } catch (error) {
          this.log.error(`${fnTag} Kademlia discovery failed: ${error.message}`);
        }
      }

      // Step 3: Fallback to static gateways
      this.log.info(`${fnTag} Falling back to static gateway configuration`);
      const staticGateways = this.getStaticGatewaysForBlockchain(blockchainId);
      
      if (staticGateways.length > 0) {
        this.log.info(`${fnTag} Found ${staticGateways.length} static gateway(s) for ${blockchainId}`);
        this.cacheGateways(blockchainId, staticGateways);
        return staticGateways;
      }

      // Step 4: No gateways found
      this.log.warn(`${fnTag} No gateways found for blockchain ${blockchainId}`);
      return [];

    } catch (error) {
      this.log.error(`${fnTag} Error resolving gateways: ${error.message}`);
      throw new Error(`Failed to resolve gateways for blockchain ${blockchainId}: ${error.message}`);
    }
  }

  /**
   * Resolve a specific gateway by ID (maintains backward compatibility)
   */
  public async resolveGatewayID(ID: string): Promise<GatewayIdentity> {
    const fnTag = `${EnhancedGatewayResolver.CLASS_NAME}#resolveGatewayID()`;
    this.log.info(`${fnTag} Resolving gateway with ID: ${ID}`);

    // First try static gateways for exact ID match
    const staticGateway = this.options.staticGateways?.find(gw => gw.id === ID);
    if (staticGateway) {
      this.log.info(`${fnTag} Found static gateway with ID: ${ID}`);
      return staticGateway;
    }

    // If not found in static, try to find in any cached gateways
    for (const [blockchainId, cachedGateways] of this.gatewayCache.entries()) {
      const gateway = cachedGateways.find(cg => cg.gateway.id === ID);
      if (gateway && !this.isCacheExpired(gateway.discoveredAt)) {
        this.log.info(`${fnTag} Found cached gateway with ID: ${ID} for blockchain: ${blockchainId}`);
        return gateway.gateway;
      }
    }

    throw new Error(`Gateway with ID ${ID} not found`);
  }

  /**
   * Get cached gateways for a blockchain if not expired
   */
  private getCachedGateways(blockchainId: string): GatewayIdentity[] {
    const cached = this.gatewayCache.get(blockchainId);
    if (!cached) {
      return [];
    }

    // Filter out expired cache entries
    const validCached = cached.filter(cg => !this.isCacheExpired(cg.discoveredAt));
    
    if (validCached.length !== cached.length) {
      // Update cache to remove expired entries
      if (validCached.length === 0) {
        this.gatewayCache.delete(blockchainId);
      } else {
        this.gatewayCache.set(blockchainId, validCached);
      }
    }

    return validCached.map(cg => cg.gateway);
  }

  /**
   * Cache discovered gateways
   */
  private cacheGateways(blockchainId: string, gateways: GatewayIdentity[]): void {
    const now = Date.now();
    const cachedGateways: CachedGateway[] = gateways.map(gateway => ({
      gateway,
      discoveredAt: now,
    }));

    this.gatewayCache.set(blockchainId, cachedGateways);
    this.log.debug(`Cached ${gateways.length} gateway(s) for blockchain: ${blockchainId}`);
  }

  /**
   * Check if cache entry is expired
   */
  private isCacheExpired(discoveredAt: number): boolean {
    return Date.now() - discoveredAt > (this.options.cacheTimeout || 300000);
  }

  /**
   * Get static gateways that support a specific blockchain
   */
  private getStaticGatewaysForBlockchain(blockchainId: string): GatewayIdentity[] {
    if (!this.options.staticGateways) {
      return [];
    }

    return this.options.staticGateways.filter(gateway =>
      gateway.connectedDLTs?.some(dlt => 
        dlt.id.toLowerCase() === blockchainId.toLowerCase()
      )
    );
  }

  /**
   * Clear cache for a specific blockchain or all
   */
  public clearCache(blockchainId?: string): void {
    if (blockchainId) {
      this.gatewayCache.delete(blockchainId);
      this.log.debug(`Cleared cache for blockchain: ${blockchainId}`);
    } else {
      this.gatewayCache.clear();
      this.log.debug("Cleared all gateway cache");
    }
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { [blockchainId: string]: { count: number; age: string } } {
    const stats: { [blockchainId: string]: { count: number; age: string } } = {};
    const now = Date.now();

    for (const [blockchainId, cached] of this.gatewayCache.entries()) {
      const validCached = cached.filter(cg => !this.isCacheExpired(cg.discoveredAt));
      if (validCached.length > 0) {
        const oldestCache = Math.min(...validCached.map(cg => cg.discoveredAt));
        const ageMs = now - oldestCache;
        const ageMinutes = Math.floor(ageMs / 60000);
        
        stats[blockchainId] = {
          count: validCached.length,
          age: `${ageMinutes}m`,
        };
      }
    }

    return stats;
  }

  /**
   * Manual refresh of gateways for a blockchain (bypasses cache)
   */
  public async refreshGateways(blockchainId: string): Promise<GatewayIdentity[]> {
    this.clearCache(blockchainId);
    return this.resolveGatewaysByBlockchain(blockchainId);
  }
}