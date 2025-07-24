import "jest-extended";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  pruneDockerAllIfGithubAction,
  Containers,
} from "@hyperledger/cactus-test-tooling";
import {
  SATPGatewayConfig,
  SATPGateway,
  PluginFactorySATPGateway,
  TokenType,
} from "../../../main/typescript";
import {
  Address,
  GatewayIdentity,
} from "../../../main/typescript/core/types";
import {
  IPluginFactoryOptions,
  LedgerType,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import { ClaimFormat } from "../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import {
  BesuTestEnvironment,
  FabricTestEnvironment,
  getTransactRequest,
} from "../test-utils";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../main/typescript/core/constants";

import { Knex, knex } from "knex";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { createMigrationSource } from "../../../main/typescript/database/knex-migration-source";
import { knexRemoteInstance } from "../../../main/typescript/database/knexfile-remote";

const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Kademlia Discovery Test",
});


let knexSourceRemoteClient: Knex;
let knexTargetRemoteClient: Knex;
let fabricEnv: FabricTestEnvironment;
let besuEnv: BesuTestEnvironment;
let gateway1: SATPGateway;
let gateway2: SATPGateway;

// Kademlia network configuration
const KADEMLIA_NODE_URL = "http://localhost:2001";

/**
 * Helper function to store gateway in Kademlia network
 */
async function storeGatewayInKademlia(
  blockchainId: string,
  gateway: GatewayIdentity,
  gatewayPubKey: string
): Promise<void> {
  const fnTag = "storeGatewayInKademlia";
  log.info(`${fnTag} Storing gateway ${gateway.id} for blockchain ${blockchainId} in Kademlia network`);
  
  try {
    // Construct the gateway endpoint URL (address + server port)
    const gatewayEndpoint = `${gateway.address}:${gateway.gatewayServerPort}`;
    
    // Use the POST endpoint with JSON body
    const storeUrl = `${KADEMLIA_NODE_URL}/secure/storeGateway`;
    
    const requestBody = {
      blockchainId: blockchainId,
      endpoint: gatewayEndpoint,
      pubKey: gatewayPubKey,
    };
    
    const response = await fetch(storeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    log.info(`${fnTag} Successfully stored gateway endpoint ${gatewayEndpoint} for blockchain ${blockchainId} in Kademlia: ${JSON.stringify(result)}`);
  } catch (error) {
    log.error(`${fnTag} Failed to store gateway in Kademlia: ${error.message}`);
    throw error;
  }
}

/**
 * Helper function to verify gateway discovery from Kademlia
 */
async function verifyGatewayDiscovery(
  blockchainId: string
): Promise<boolean> {
  const fnTag = "verifyGatewayDiscovery";
  log.info(`${fnTag} Verifying gateway discovery for blockchain ${blockchainId}`);
  
  try {
    const findUrl = `${KADEMLIA_NODE_URL}/secure/findGateway/${encodeURIComponent(blockchainId)}?includeUnhealthy=true`;
    
    const response = await fetch(findUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    log.info(`${fnTag} Discovery result: ${JSON.stringify(result)}`);
    
    // Check if the expected gateway is found
    const foundGateways = result.gateways || [];
    log.info(`${fnTag} Found ${foundGateways.length} gateway(s) in discovery result`);
    
    // Since we're looking for any gateway that can serve the blockchain,
    // we just need to verify that at least one gateway was found
    if (foundGateways.length > 0) {
      const firstGateway = foundGateways[0];
      log.info(`${fnTag} Found gateway with endpoint: ${firstGateway.endpoint}, nodeId: ${firstGateway.nodeId}`);
      
      // Check if the gateway supports the expected blockchain
      if (firstGateway.blockchainId === blockchainId) {
        log.info(`${fnTag} Successfully found gateway for blockchain: ${blockchainId}`);
        return true;
      } else {
        log.warn(`${fnTag} Gateway blockchain mismatch. Expected: ${blockchainId}, Found: ${firstGateway.blockchainId}`);
        return false;
      }
    } else {
      log.warn(`${fnTag} No gateways found for blockchain: ${blockchainId}`);
      return false;
    }
  } catch (error) {
    log.error(`${fnTag} Failed to verify gateway discovery: ${error.message}`);
    return false;
  }
}

async function shutdownGateways() {
  if (gateway1) {
    await gateway1.shutdown();
  }
  if (gateway2) {
    await gateway2.shutdown();
  }
}

const TIMEOUT = 900000; // 15 minutes
afterAll(async () => {
  if (gateway1) {
    if (knexSourceRemoteClient) {
      await knexSourceRemoteClient.destroy();
    }
  }

  if (gateway2) {
    if (knexTargetRemoteClient) {
      await knexTargetRemoteClient.destroy();
    }
  }

  await shutdownGateways();
  await besuEnv?.tearDown();
  await fabricEnv?.tearDown();

  await pruneDockerAllIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
}, TIMEOUT);

beforeAll(async () => {
  pruneDockerAllIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });

  {
    const satpContractName = "satp-contract";
    fabricEnv = await FabricTestEnvironment.setupTestEnvironment({
      contractName: satpContractName,
      logLevel,
      claimFormat: ClaimFormat.BUNGEE,
    });
    log.info("Fabric Ledger started successfully");

    await fabricEnv.deployAndSetupContracts();
  }

  {
    const erc20TokenContract = "SATPContract";
    besuEnv = await BesuTestEnvironment.setupTestEnvironment({
      contractName: erc20TokenContract,
      logLevel,
    });
    log.info("Besu Ledger started successfully");

    await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  }
}, TIMEOUT);

describe("2 SATPGateways with Kademlia Discovery - Besu to Fabric", () => {
  jest.setTimeout(TIMEOUT);
  
  it("should mint 100 tokens to the owner account", async () => {
    await besuEnv.mintTokens("100");
    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "100",
      besuEnv.getTestOwnerSigningCredential(),
    );
  });
  
  it("should store destination gateway in Kademlia and realize a transfer using discovery", async () => {
    // Setup SATP gateway factory
    const factoryOptions: IPluginFactoryOptions = {
      pluginImportType: PluginImportType.Local,
    };
    const factory = new PluginFactorySATPGateway(factoryOptions);

    // Gateway 1 - Besu (source)
    const gatewayIdentity1 = {
      id: "mockID-1",
      name: "CustomGateway",
      version: [
        {
          Core: SATP_CORE_VERSION,
          Architecture: SATP_ARCHITECTURE_VERSION,
          Crash: SATP_CRASH_VERSION,
        },
      ],
      connectedDLTs: [
        {
          id: BesuTestEnvironment.BESU_NETWORK_ID,
          ledgerType: LedgerType.Besu2X,
        },
      ],
      proofID: "mockProofID10",
      address: "http://localhost" as Address,
      gatewayOapiPort: 4010,
      gatewayServerPort: 5010,
      gatewayClientPort: 5011,
    } as GatewayIdentity;

    // Gateway 2 - Fabric (destination)
    const gatewayIdentity2 = {
      id: "mockID-2",
      name: "CustomGateway",
      version: [
        {
          Core: SATP_CORE_VERSION,
          Architecture: SATP_ARCHITECTURE_VERSION,
          Crash: SATP_CRASH_VERSION,
        },
      ],
      connectedDLTs: [
        {
          id: FabricTestEnvironment.FABRIC_NETWORK_ID,
          ledgerType: LedgerType.Fabric2,
        },
      ],
      proofID: "mockProofID11",
      address: "http://localhost" as Address,
      gatewayOapiPort: 4011,
      gatewayServerPort: 5012,
      gatewayClientPort: 5013,
    } as GatewayIdentity;

    // Setup database connections
    const migrationSource = await createMigrationSource();
    knexSourceRemoteClient = knex({
      ...knexRemoteInstance.default,
      migrations: {
        migrationSource: migrationSource,
      },
    });
    await knexSourceRemoteClient.migrate.latest();

    knexTargetRemoteClient = knex({
      ...knexRemoteInstance.default,
      migrations: {
        migrationSource: migrationSource,
      },
    });
    await knexTargetRemoteClient.migrate.latest();

    const fabricNetworkOptions = fabricEnv.createFabricConfig();
    const besuNetworkOptions = besuEnv.createBesuConfig();

    const ontologiesPath = path.join(__dirname, "../../ontologies");

    const options1: SATPGatewayConfig = {
      instanceId: uuidv4(),
      logLevel: "DEBUG",
      gid: gatewayIdentity1,
      ccConfig: {
        bridgeConfig: [besuNetworkOptions],
      },
      counterPartyGateways: [], 
      remoteRepository: knexRemoteInstance.default,
      pluginRegistry: new PluginRegistry({ plugins: [] }),
      ontologyPath: ontologiesPath,
      kademliaDiscovery: {
        enabled: true,
        nodes: [KADEMLIA_NODE_URL],
        requestTimeout: 5000,
        includeUnhealthy: true,
        maxAge: 60,
        useSecure: true,
      },
    };

    const options2: SATPGatewayConfig = {
      instanceId: uuidv4(),
      logLevel: "DEBUG",
      gid: gatewayIdentity2,
      ccConfig: {
        bridgeConfig: [fabricNetworkOptions],
      },
      counterPartyGateways: [],
      remoteRepository: knexRemoteInstance.default,
      pluginRegistry: new PluginRegistry({ plugins: [] }),
      ontologyPath: ontologiesPath,

      kademliaDiscovery: {
        enabled: true,
        nodes: [KADEMLIA_NODE_URL],
        requestTimeout: 5000,
        includeUnhealthy: false,
        maxAge: 60,
        useSecure: true,
      },
    };

    gateway1 = await factory.create(options1);
    expect(gateway1).toBeInstanceOf(SATPGateway);
    gateway2 = await factory.create(options2);
    expect(gateway2).toBeInstanceOf(SATPGateway);

    const identity1 = gateway1.Identity;
    expect(identity1.gatewayServerPort).toBe(5010);
    expect(identity1.gatewayClientPort).toBe(5011);
    expect(identity1.address).toBe("http://localhost");

    const identity2 = gateway2.Identity;
    expect(identity2.gatewayServerPort).toBe(5012);
    expect(identity2.gatewayClientPort).toBe(5013);
    expect(identity2.address).toBe("http://localhost");

    await gateway1.startup();
    await gateway2.startup();

    const dispatcher1 = gateway1.BLODispatcherInstance;
    const dispatcher2 = gateway2.BLODispatcherInstance;

    expect(dispatcher1).toBeTruthy();
    expect(dispatcher2).toBeTruthy();

    const reqApproveBesuAddress = await dispatcher1?.GetApproveAddress({
      networkId: besuEnv.network,
      tokenType: TokenType.NonstandardFungible,
    });
    expect(reqApproveBesuAddress?.approveAddress).toBeDefined();

    if (!reqApproveBesuAddress?.approveAddress) {
      throw new Error("Approve address is undefined");
    }

    await besuEnv.giveRoleToBridge(reqApproveBesuAddress?.approveAddress);

    if (reqApproveBesuAddress?.approveAddress) {
      await besuEnv.approveAmount(reqApproveBesuAddress.approveAddress, "100");
    } else {
      throw new Error("Approve address is undefined");
    }
    log.debug("Approved 100 amount to the Besu Bridge Address");

    const reqApproveFabricAddress = await dispatcher2?.GetApproveAddress({
      networkId: fabricEnv.network,
      tokenType: TokenType.NonstandardFungible,
    });
    expect(reqApproveFabricAddress?.approveAddress).toBeDefined();

    if (!reqApproveFabricAddress?.approveAddress) {
      throw new Error("Approve address is undefined");
    }

    await fabricEnv.giveRoleToBridge("Org2MSP");

    const req = getTransactRequest(
      "kademliaContext",
      besuEnv,
      fabricEnv,
      "100",
      "100",
    );

    // START LATENCY MEASUREMENT
    const transferStartTime = performance.now();
    log.info(`Transfer started at: ${new Date().toISOString()}`);
    await storeGatewayInKademlia(BesuTestEnvironment.BESU_NETWORK_ID, gatewayIdentity1, gateway1.pubKey);
    await storeGatewayInKademlia(FabricTestEnvironment.FABRIC_NETWORK_ID, gatewayIdentity2, gateway2.pubKey);

    log.info("=== STEP 2: Verifying gateway discovery ===");
    const discoveryVerified = await verifyGatewayDiscovery(
      FabricTestEnvironment.FABRIC_NETWORK_ID);
    expect(discoveryVerified).toBe(true);

    log.info("Initiating transfer - this should trigger Kademlia discovery for the destination gateway");
    const res = await dispatcher1?.Transact(req);

    const transferEndTime = performance.now();
    const transferLatency = transferEndTime - transferStartTime;
    log.info(`Transfer response: ${res?.statusResponse}`);

    const latencyStats = {
      startTime: new Date(Date.now() - transferLatency).toISOString(),
      endTime: new Date().toISOString(),
      latencyMs: Math.round(transferLatency),
      latencySeconds: Math.round(transferLatency / 1000 * 100) / 100,
      transferType: "Besu to Fabric with Kademlia Discovery"
    };

    expect(res?.statusResponse).toBeDefined();


    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "0",
      besuEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount was transferred correctly from the Besu Owner account");

    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      reqApproveBesuAddress?.approveAddress,
      "0",
      besuEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount was transferred correctly to the Besu Wrapper account");

    await fabricEnv.checkBalance(
      fabricEnv.getTestContractName(),
      fabricEnv.getTestChannelName(),
      reqApproveFabricAddress?.approveAddress,
      "0",
      fabricEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount was transferred correctly from the Fabric Bridge account");

    await fabricEnv.checkBalance(
      fabricEnv.getTestContractName(),
      fabricEnv.getTestChannelName(),
      fabricEnv.getTestOwnerAccount(),
      "100",
      fabricEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount was transferred correctly to the Fabric Owner account");
    log.info(`Latency Statistics: ${JSON.stringify(latencyStats, null, 2)}`);
    await shutdownGateways();
  });
});