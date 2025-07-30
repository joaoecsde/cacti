// a helper class to manage connections to counterparty gateways
import {
  ILoggerOptions,
  JsObjectSigner,
  LogLevelDesc,
  Logger,
  LoggerProvider,
} from "@hyperledger/cactus-common";
import {
  GatewayIdentity,
  GatewayChannel,
  SATPServiceInstance,
  Address,
} from "../../core/types";
import {
  Client as ConnectClient,
  Transport as ConnectTransport,
} from "@connectrpc/connect";

import { Express } from "express";
import { stringify as safeStableStringify } from "safe-stable-stringify";

import { expressConnectMiddleware } from "@connectrpc/connect-express";

import { SatpStage0Service } from "../../generated/proto/cacti/satp/v02/service/stage_0_pb";
import { SatpStage1Service } from "../../generated/proto/cacti/satp/v02/service/stage_1_pb";
import { SatpStage2Service } from "../../generated/proto/cacti/satp/v02/service/stage_2_pb";
import { SatpStage3Service } from "../../generated/proto/cacti/satp/v02/service/stage_3_pb";
import { CrashRecoveryService } from "../../generated/proto/cacti/satp/v02/service/crash_recovery_pb";

import { KademliaGatewayDiscoveryService} from "../network-identification/kademlia-gateway-discovery";
import { LedgerType } from "@hyperledger/cactus-core-api";


export interface IGatewayOrchestratorOptions {
  logLevel?: LogLevelDesc;
  localGateway: GatewayIdentity;
  counterPartyGateways?: GatewayIdentity[];
  signer: JsObjectSigner;
  enableCrashRecovery?: boolean;

  kademliaDiscovery?: {
    enabled: boolean;
    nodes: string[];
    requestTimeout?: number;
    includeUnhealthy?: boolean;
    maxAge?: number;
    useSecure?: boolean;
  };
}

//import { COREDispatcher, COREDispatcherOptions } from "../../core/dispatcher";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-node";
import {
  getGatewaySeeds,
  resolveGatewayID,
} from "../network-identification/resolve-gateway";
import { SATPHandler, Stage } from "../../types/satp-protocol";
import { BridgeManagerClientInterface } from "../../cross-chain-mechanisms/bridge/interfaces/bridge-manager-client-interface";
import { NetworkId } from "../../public-api";

export class GatewayOrchestrator {
  public readonly label = "GatewayOrchestrator";
  private expressServer: Express | undefined;
  protected localGateway: GatewayIdentity;
  private counterPartyGateways: Map<string, GatewayIdentity> = new Map();
  private handlers: Map<string, SATPHandler> = new Map();
  private crashEnabled: boolean = false;
  private bridgeManager?: BridgeManagerClientInterface;

  // TODO!: add logic to manage sessions (parallelization, user input, freeze, unfreeze, rollback, recovery)
  private channels: Map<string, GatewayChannel> = new Map();
  private readonly logger: Logger;

  private kademliaDiscovery?: KademliaGatewayDiscoveryService;

  constructor(options: IGatewayOrchestratorOptions) {
    // add checks
    this.localGateway = options.localGateway;
    const level = options.logLevel || "INFO";
    const logOptions: ILoggerOptions = {
      level: level,
      label: this.label,
    };

    this.logger = LoggerProvider.getOrCreate(logOptions);
    this.logger.info("Initializing Gateway Connection Manager");
    this.logger.info("Gateway Coordinator initialized");
    this.crashEnabled = options.enableCrashRecovery ?? false;
    this.logger.info(`Crash recovery set to: ${this.crashEnabled}`);
    const seedGateways = getGatewaySeeds(this.logger);
    this.logger.info(
      `Initializing gateway connection manager with ${seedGateways} seed gateways`,
    );

    const allCounterPartyGateways = seedGateways.concat(
      options.counterPartyGateways ?? [],
    );

    // populate counterPartyGateways
    this.counterPartyGateways = new Map(
      allCounterPartyGateways.map((gateway) => [gateway.id, gateway]),
    );

    this.logger.info(
      `Gateway Connection Manager bootstrapped with ${allCounterPartyGateways.length} gateways`,
    );

    this.addGateways(allCounterPartyGateways);
    const numberGatewayChannels = this.connectToCounterPartyGateways();
    if (numberGatewayChannels > 0) {
      this.logger.info(
        `Gateway Connection Manager connected to ${numberGatewayChannels} gateways.`,
      );
    }

    if (options.kademliaDiscovery?.enabled && options.kademliaDiscovery.nodes.length > 0) {
      this.kademliaDiscovery = new KademliaGatewayDiscoveryService({
        kademliaNodes: options.kademliaDiscovery.nodes,
        logLevel: options.logLevel,
        requestTimeout: options.kademliaDiscovery.requestTimeout,
        includeUnhealthy: options.kademliaDiscovery.includeUnhealthy,
        maxAge: options.kademliaDiscovery.maxAge,
        useSecure: options.kademliaDiscovery.useSecure,
      });
      
      this.logger.info(`Kademlia discovery enabled with ${options.kademliaDiscovery.nodes.length} nodes`);
    } else {
      this.logger.info("Kademlia discovery disabled");
    }
  }

  public get ourGateway(): GatewayIdentity {
    return this.localGateway;
  }

  public addBridgeManager(bridgeManager: BridgeManagerClientInterface): void {
    this.bridgeManager = bridgeManager;
  }

  public addGatewayOwnChannels(connectedDLTs: NetworkId[]): void {
    // add this gatways bridge channels
    const id = {
      ...this.localGateway,
      address: (this.localGateway.address ?? "").replace(
        /^(https?:\/\/)[^/]+/,
        `$1localhost`,
      ) as Address, // This is necessary, because the adress of the local gateway is localhost for it self
      connectedDLTs: connectedDLTs,
    };
    this.channels.set(this.localGateway.id, this.createChannel(id));
  }

  public addGOLServer(server: Express): void {
    this.expressServer = server;
  }

  public startServices(): void {
    if (!this.expressServer) {
      throw new Error(`${this.label}#startServices() expressServer falsy.`);
    }

    for (const stage of this.handlers.keys()) {
      const handler = this.handlers.get(stage);
      if (!handler) {
        throw new Error(`Handler for stage ${stage} is undefined.`);
      }

      const httpPath = `/${handler.getStage()}`;
      this.logger.info(`Setting up routes for stage ${httpPath}`);

      if (typeof handler.setupRouter !== "function") {
        throw new Error(
          `Handler for stage ${stage} has an invalid setupRouter function.`,
        );
      }

      this.expressServer.use(
        expressConnectMiddleware({
          routes: handler.setupRouter.bind(handler),
          requestPathPrefix: httpPath,
        }),
      );
    }
  }

  public addHandlers(handlers: Map<string, SATPHandler>): void {
    this.handlers = handlers;
  }

  async startupGatewayOrchestrator(): Promise<void> {
    if (this.counterPartyGateways.values.length === 0) {
      this.logger.info("No gateways to connect to");
      return;
    } else {
      this.connectToCounterPartyGateways();
    }
  }

  public getGatewayIdentity(id: string): GatewayIdentity | undefined {
    if (this.localGateway.id === id) {
      return this.localGateway;
    } else {
      return this.counterPartyGateways.get(id);
    }
  }

  public getCounterPartyGateway(id: string): GatewayIdentity | undefined {
    return this.counterPartyGateways.get(id);
  }

  public getChannel(id: string): GatewayChannel {
    const channels = Array.from(this.channels.values());
    const channel = channels.find((channel) => {
      return channel.connectedDLTs
        .map((obj: any) => {
          return obj.id;
        })
        .includes(id);
    });
    if (!channel) {
      throw new Error(
        `No channel found for DLT ${id} \n available channels: ${safeStableStringify(channels)}`,
      );
    }
    return channel;
  }

  public getChannels(): Map<string, GatewayChannel> {
    return this.channels;
  }
  isSelfId(id: string): boolean {
    return id === this.localGateway.id;
  }
  getSelfId(): string {
    return this.localGateway.id;
  }

  isInCounterPartyGateways(id: string): boolean {
    return this.counterPartyGateways.has(id);
  }

  getCounterPartyGateways(): Map<string, GatewayIdentity> {
    return this.counterPartyGateways;
  }

  isInChannels(id: string): boolean {
    return this.channels.has(id);
  }

  // Find IDs in counterPartyGateways that do not have a corresponding channel
  findUnchanneledGateways(): string[] {
    return Array.from(this.counterPartyGateways.keys()).filter((id) => {
      return !this.isInChannels(id) && !this.isSelfId(id);
    });
  }

  // Filter IDs that are not present in counterPartyGateways or channels and not the self ID
  filterNewIds(ids: string[]): string[] {
    return ids.filter((id) => {
      return (
        // !this.isInCounterPartyGateways(id) &&
        !this.isInChannels(id) && !this.isSelfId(id)
      );
    });
  }

  connectToCounterPartyGateways(): number {
    const fnTag = `${this.label}#connectToCounterPartyGateways()`;
    if (!this.counterPartyGateways) {
      this.logger.info(`${fnTag}, No counterparty gateways to connect to`);
      return 0;
    }

    const idsToAdd = this.filterNewIds(
      Array.from(this.counterPartyGateways.keys()),
    );
    if (idsToAdd.length === 0) {
      this.logger.info(`${fnTag}, No new gateways to connect to`);
      return 0;
    }

    // get gateway identities from counterPartyGateways
    const gatewaysToAdd = idsToAdd.map(
      (id) => this.counterPartyGateways.get(id)!,
    );

    let connected = 0;
    try {
      for (const gateway of gatewaysToAdd) {
        const channel = this.createChannel(gateway);
        this.channels.set(gateway.id, channel);
        connected++;
      }
    } catch (ex) {
      this.logger.error(`${fnTag}, Failed to connect to gateway`);
      this.logger.error(ex);
    }
    return connected;
  }

  get connectedDLTs(): NetworkId[] {
    if (!this.bridgeManager) return [];
    return this.bridgeManager.getAvailableEndPoints();
  }

  createChannel(identity: GatewayIdentity): GatewayChannel {
    if (identity.gatewayClientPort === undefined) {
      throw new Error(
        `Gateway ${identity.id} does not have a gatewayClientPort defined`,
      );
    }
    if (identity.gatewayServerPort === undefined) {
      throw new Error(
        `Gateway ${identity.id} does not have a gatewayServerPort defined`,
      );
    }
    const clients = this.createConnectClients(identity);

    if (!identity.connectedDLTs) {
      throw new Error(
        `Gateway ${identity.id} does not have connectedDLTs defined`,
      );
    }

    const channel: GatewayChannel = {
      fromGatewayID: this.localGateway.id,
      toGatewayID: identity.id,
      sessions: new Map(),
      clients: clients,
      connectedDLTs: identity.connectedDLTs,
    };
    this.logger.info(
      `Created channel to gateway ${identity.id} \n reachable DLTs: ${identity.connectedDLTs}`,
    );
    return channel;
  }

  protected getTargetChannel(id: string): GatewayChannel {
    const channel = this.channels.get(id);
    if (!channel) {
      throw new Error(`Channel with gateway id ${id} does not exist`);
    } else {
      return channel;
    }
  }

  private createConnectClients(
    identity: GatewayIdentity,
  ): Map<string, ConnectClient<SATPServiceInstance>> {
    // one function for each client type; aggregate in array
    this.logger.debug(
      `Creating clients for gateway ${safeStableStringify(identity)}`,
    );
    const transport0 = createGrpcWebTransport({
      baseUrl:
        identity.address +
        ":" +
        identity.gatewayServerPort +
        `/${Stage.STAGE0}`,
      httpVersion: "1.1",
    });

    this.logger.debug(
      "Transport:" +
        identity.address +
        ":" +
        identity.gatewayServerPort +
        `/${Stage.STAGE0}`,
    );

    const transport1 = createGrpcWebTransport({
      baseUrl:
        identity.address +
        ":" +
        identity.gatewayServerPort +
        `/${Stage.STAGE1}`,
      httpVersion: "1.1",
    });

    const transport2 = createGrpcWebTransport({
      baseUrl:
        identity.address +
        ":" +
        identity.gatewayServerPort +
        `/${Stage.STAGE2}`,
      httpVersion: "1.1",
    });

    const transport3 = createGrpcWebTransport({
      baseUrl:
        identity.address +
        ":" +
        identity.gatewayServerPort +
        `/${Stage.STAGE3}`,
      httpVersion: "1.1",
    });

    const transportCrash = createGrpcWebTransport({
      baseUrl:
        identity.address + ":" + identity.gatewayServerPort + `/${"crash"}`,
      httpVersion: "1.1",
    });

    const clients: Map<string, ConnectClient<SATPServiceInstance>> = new Map();

    clients.set("0", this.createStage0ServiceClient(transport0));
    clients.set("1", this.createStage1ServiceClient(transport1));
    clients.set("2", this.createStage2ServiceClient(transport2));
    clients.set("3", this.createStage3ServiceClient(transport3));

    if (this.crashEnabled) {
      clients.set("crash", this.createCrashServiceClient(transportCrash));
    }
    // todo perform healthcheck on startup; should be in stage 0
    return clients;
  }

  private createStage0ServiceClient(
    transport: ConnectTransport,
  ): ConnectClient<typeof SatpStage0Service> {
    this.logger.debug(
      "Creating stage 0 service client, with transport: ",
      transport,
    );
    const client = createClient(SatpStage0Service, transport);
    return client;
  }

  private createStage1ServiceClient(
    transport: ConnectTransport,
  ): ConnectClient<typeof SatpStage1Service> {
    this.logger.debug(
      "Creating stage 1 service client, with transport: ",
      transport,
    );
    const client = createClient(SatpStage1Service, transport);
    return client;
  }

  private createStage2ServiceClient(
    transport: ConnectTransport,
  ): ConnectClient<typeof SatpStage2Service> {
    this.logger.debug(
      "Creating stage 2 service client, with transport: ",
      transport,
    );
    const client = createClient(SatpStage2Service, transport);
    return client;
  }

  private createStage3ServiceClient(
    transport: ConnectTransport,
  ): ConnectClient<typeof SatpStage3Service> {
    this.logger.debug(
      "Creating stage 3 service client, with transport: ",
      transport,
    );
    const client = createClient(SatpStage3Service, transport);
    return client;
  }

  private createCrashServiceClient(
    transport: ConnectTransport,
  ): ConnectClient<typeof CrashRecoveryService> {
    this.logger.debug(
      "Creating crash-manager client, with transport: ",
      transport,
    );
    const client = createClient(CrashRecoveryService, transport);
    return client;
  }

  public async resolveAndAddGateways(IDs: string[]): Promise<number> {
    const fnTag = `${this.label}#addGateways()`;
    this.logger.trace(`Entering ${fnTag}`);
    this.logger.info("Connecting to gateway");
    const gatewaysToAdd: GatewayIdentity[] = [];
    const thisID = this.localGateway!.id;
    const otherIDs = IDs.filter((id) => id !== thisID);

    for (const id of otherIDs) {
      gatewaysToAdd.push(await resolveGatewayID(this.logger, id));
    }

    this.addGateways(gatewaysToAdd);
    return gatewaysToAdd.length;
  }

  public addGateways(gateways: GatewayIdentity[]): string[] {
    const fnTag = `${this.label}#addGateways()`;
    this.logger.trace(`Entering ${fnTag}`);
    this.logger.info("Connecting to gateway");
    const addedIDs: string[] = [];
    // gateways tha are not self
    const otherGateways = gateways.filter(
      (gateway) => gateway.id !== this.localGateway.id,
    );

    // gateways that are not already connected
    const uniqueGateways = otherGateways.filter(
      (gateway) => !this.counterPartyGateways.has(gateway.id),
    );

    for (const gateway of uniqueGateways) {
      this.counterPartyGateways.set(gateway.id, gateway);
      addedIDs.push(gateway.id);
    }
    this.logger.debug(`Added ${addedIDs.length} gateways: ${addedIDs}`);
    return addedIDs;
  }

  public async addGatewayAndCreateChannel(
    gateway: GatewayIdentity,
  ): Promise<void> {
    const fnTag = `${this.label}#addGateway()`;
    this.logger.trace(`Entering ${fnTag}`);
    this.logger.info("Connecting to gateway");
    if (this.localGateway.id === gateway.id) {
      this.logger.error(
        `${fnTag}, Cannot add self gateway ${gateway.id} to counterPartyGateways`,
      );
      return;
    }
    if (this.counterPartyGateways.has(gateway.id)) {
      this.logger.error(
        `${fnTag}, Gateway ${gateway.id} already exists in counterPartyGateways`,
      );
      return;
    }
    this.channels.set(gateway.id, this.createChannel(gateway));
    this.counterPartyGateways.set(gateway.id, gateway);
  }

  alreadyConnected(ID: string): boolean {
    return this.channels.has(ID);
  }

  async disconnectAll(): Promise<number> {
    const fnTag = `${this.label}#disconnectAll()`;

    let counter = 0;
    //removed async
    this.channels.forEach((channel) => {
      this.logger.info(`${fnTag}, Disconnecting from ${channel.toGatewayID}`);
      // ! todo implement disconnect
      this.logger.warn("Disconnect All Not implemented");
      counter++;
    });
    this.channels.clear();
    return counter;
  }

  /*
  BOL TO GOL translation
  */
  async handleTransferRequest(): Promise<void> {
    // add checks
    this.logger.info("Handling transfer request");
    // ! todo implement transfer request
    this.logger.error("Not implemented");
  }

  async handleGetRoutes(): Promise<void> {
    // add checks
    this.logger.info("Handling transfer request");
    // ! todo implement transfer request
    this.logger.error("Not implemented");
  }

  //Get channel with Kademlia discovery fallback
  public async getChannelWithAutoDiscovery(dltId: string): Promise<GatewayChannel> {
    const fnTag = `${this.constructor.name}#getChannelWithAutoDiscovery()`;
    try {
      // Try existing channel first
      return this.getChannel(dltId);
    } catch (error) {
      // No static channel found, try Kademlia discovery
      this.logger.info(`${fnTag} No static channel for DLT ${dltId}, attempting Kademlia discovery`);
      
      if (!this.kademliaDiscovery) {
        throw new Error(`No static channel found for DLT ${dltId} and Kademlia discovery not configured`);
      }
      
      const discoveredGateways = await this.kademliaDiscovery.discoverGateways(dltId);
      
      if (discoveredGateways.length === 0) {
        throw new Error(`No gateways discovered for DLT ${dltId}`);
      }
      
      // Add and connect to the first discovered gateway
      const selectedGateway = discoveredGateways[0];
      await this.addGatewayAndCreateChannel(selectedGateway);
      
      // Return the newly created channel
      return this.getChannel(dltId);
    }
  }

  // NEW METHOD: Async discovery and channel creation  
  public async discoverAndCreateChannel(dltId: string): Promise<GatewayChannel> {
    const fnTag = `${this.constructor.name}#discoverAndCreateChannel()`;
    
    if (!this.kademliaDiscovery) {
      throw new Error(`Kademlia discovery not configured for DLT ${dltId}`);
    }

    try {
      this.logger.info(`${fnTag} Searching Kademlia network for gateways supporting DLT: ${dltId}`);
      const discoveredGateways = await this.kademliaDiscovery.discoverGateways(dltId);

      if (discoveredGateways.length === 0) {
        throw new Error(`No gateways found for DLT ${dltId} in Kademlia network`);
      }

      this.logger.info(`${fnTag} Found ${discoveredGateways.length} gateway(s) for DLT ${dltId} via Kademlia`);

      // Select the first healthy gateway
      const selectedGateway = discoveredGateways[0];
      this.logger.info(`${fnTag} Selected gateway: ${selectedGateway.name} (${selectedGateway.id})`);

      // Create and establish a new channel with the discovered gateway
      const newChannel = await this.createChannelFromDiscoveredGateway(selectedGateway, dltId);
      
      this.logger.info(`${fnTag} Successfully created channel for DLT ${dltId} via Kademlia discovery`);
      return newChannel;

    } catch (discoveryError) {
      this.logger.error(`${fnTag} Kademlia discovery failed for DLT ${dltId}: ${discoveryError.message}`);
      throw new Error(`Kademlia discovery failed for DLT ${dltId}: ${discoveryError.message}`);
    }
  }

  // NEW METHOD: Create a channel from a discovered gateway
  private async createChannelFromDiscoveredGateway(
    gateway: GatewayIdentity, 
    dltId: string
  ): Promise<GatewayChannel> {
    const fnTag = `${this.constructor.name}#createChannelFromDiscoveredGateway()`;
    
    try {
      this.logger.debug(`${fnTag} Creating channel for gateway: ${gateway.id}`);

      // Add the discovered gateway to our known gateways
      this.counterPartyGateways.set(gateway.id, gateway);

      // Create the channel following the existing pattern
      const channel: GatewayChannel = {
        fromGatewayID: this.localGateway.id,
        toGatewayID: gateway.id,
        sessions: new Map(),
        connectedDLTs: gateway.connectedDLTs || [{ id: dltId, ledgerType: LedgerType.Besu2X }],
        clients: new Map(),
      };

      // Store the channel
      const channelKey = `${this.localGateway.id}-${gateway.id}`;
      this.channels.set(channelKey, channel);

      // Establish connection to the discovered gateway
      await this.establishConnectionToGateway(gateway);

      this.logger.info(`${fnTag} Channel created and connection established for gateway: ${gateway.id}`);
      return channel;

    } catch (error) {
      this.logger.error(`${fnTag} Failed to create channel: ${error.message}`);
      throw new Error(`Failed to create channel for discovered gateway ${gateway.id}: ${error.message}`);
    }
  }

  // NEW METHOD: Establish connection to a discovered gateway
  private async establishConnectionToGateway(gateway: GatewayIdentity): Promise<void> {
    const fnTag = `${this.constructor.name}#establishConnectionToGateway()`;
    
    try {
      this.logger.debug(`${fnTag} Establishing connection to gateway: ${gateway.address}:${gateway.gatewayServerPort}`);

      // Create gRPC transport to the discovered gateway
      const transport = createGrpcWebTransport({
        baseUrl: `${gateway.address}:${gateway.gatewayServerPort}`,
        httpVersion: "2",
      });

      // Create clients for all stages
      const stage0Client = createClient(SatpStage0Service, transport);
      const stage1Client = createClient(SatpStage1Service, transport);
      const stage2Client = createClient(SatpStage2Service, transport);
      const stage3Client = createClient(SatpStage3Service, transport);

      // Store clients in the channel
      const channel = this.getChannelByGatewayId(gateway.id);
      if (channel) {
        channel.clients.set("0", stage0Client);
        channel.clients.set("1", stage1Client);
        channel.clients.set("2", stage2Client);
        channel.clients.set("3", stage3Client);
      }

      this.logger.info(`${fnTag} Successfully connected to gateway: ${gateway.id}`);

    } catch (error) {
      this.logger.error(`${fnTag} Failed to establish connection: ${error.message}`);
      throw error;
    }
  }

  // NEW HELPER METHOD: Get channel by gateway ID
  private getChannelByGatewayId(gatewayId: string): GatewayChannel | undefined {
    const channels = Array.from(this.channels.values());
    return channels.find(channel => channel.toGatewayID === gatewayId);
  }

  // NEW METHOD: Get Kademlia discovery statistics
  public getKademliaStats(): { enabled: boolean; nodeCount: number } {
    return {
      enabled: !!this.kademliaDiscovery,
      nodeCount: this.kademliaDiscovery?.getConfig().kademliaNodes.length || 0,
    };
  }

  // NEW METHOD: Manually trigger discovery for testing
  public async discoverGatewaysForDLT(dltId: string): Promise<GatewayIdentity[]> {
    if (!this.kademliaDiscovery) {
      throw new Error("Kademlia discovery not configured");
    }
    
    this.logger.info(`Manual discovery request for DLT: ${dltId}`);
    return await this.kademliaDiscovery.discoverGateways(dltId);
  }

}
