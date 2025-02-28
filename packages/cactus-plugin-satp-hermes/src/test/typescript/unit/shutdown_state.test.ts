import "jest-extended";
import {
  Containers,
  pruneDockerAllIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import {
  LogLevelDesc,
  LoggerProvider,
  Servers,
} from "@hyperledger/cactus-common";
import {
  ApiServer,
  AuthorizationProtocol,
  ConfigService,
} from "@hyperledger/cactus-cmd-api-server";
import { ApiClient } from "@hyperledger/cactus-api-client";

import {
  SATPGateway,
  SATPGatewayConfig,
} from "../../../main/typescript/plugin-satp-hermes-gateway";
import { PluginFactorySATPGateway } from "../../../main/typescript/factory/plugin-factory-gateway-orchestrator";
import {
  Configuration,
  IPluginFactoryOptions,
  LedgerType,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import { ShutdownHook } from "../../../main/typescript/core/types";
import {
  DEFAULT_PORT_GATEWAY_API,
  DEFAULT_PORT_GATEWAY_CLIENT,
  DEFAULT_PORT_GATEWAY_SERVER,
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../main/typescript/core/constants";
import { AddressInfo } from "net";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { AdminApi } from "../../../main/typescript";
import {
  knexClientConnection,
  knexSourceRemoteConnection,
} from "../knex.config";
import { SATPSession } from "../../../main/typescript/core/satp-session";
import {
  SessionData,
  State as SessionState,
} from "../../../main/typescript/generated/proto/cacti/satp/v02/common/session_pb";

const logLevel: LogLevelDesc = "DEBUG";
const logger = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "satp-gateway-orchestrator-init-test",
});
const factoryOptions: IPluginFactoryOptions = {
  pluginImportType: PluginImportType.Local,
};
const factory = new PluginFactorySATPGateway(factoryOptions);

let mockSession: SATPSession;
const sessionIDs: string[] = [];

beforeAll(async () => {
  pruneDockerAllIfGithubAction({ logLevel })
    .then(() => {
      logger.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
    mockSession = new SATPSession({
        contextID: "MOCK_CONTEXT_ID",
        server: false,
        client: true,
      });
    
    sessionIDs.push(mockSession.getSessionId());
});

describe("Shutdown Verify State Tests", () => {
  test("Gateway waits to verify the sessions state before shutdown", async () => {
    const options: SATPGatewayConfig = {
      gid: {
        id: "mockID",
        name: "CustomGateway",
        version: [
          {
            Core: SATP_CORE_VERSION,
            Architecture: SATP_ARCHITECTURE_VERSION,
            Crash: SATP_CRASH_VERSION,
          },
        ],
        connectedDLTs: [
          { id: "BESU", ledgerType: LedgerType.Besu2X },
          { id: "FABRIC", ledgerType: LedgerType.Fabric2 },
        ],
        proofID: "mockProofID10",
        gatewayServerPort: 3014,
        gatewayClientPort: 3015,
        address: "https://localhost",
      },
      knexLocalConfig: knexClientConnection,
      knexRemoteConfig: knexSourceRemoteConnection,
    };
  
    const gateway = await factory.create(options);
    expect(gateway).toBeInstanceOf(SATPGateway);
  
    const verifySessionsStateSpy = jest.spyOn(gateway as any, "verifySessionsState");
  
    const shutdownBLOServerSpy = jest.spyOn(gateway as any, "shutdownBLOServer");

    await gateway.startup();
    await gateway.shutdown();
 
    expect(verifySessionsStateSpy).toHaveBeenCalled();

    expect(shutdownBLOServerSpy).toHaveBeenCalled();

    verifySessionsStateSpy.mockRestore();
    shutdownBLOServerSpy.mockRestore();
  });

  test("Gateway waits for pending sessions to complete before shutdown", async () => {
    const options: SATPGatewayConfig = {
      gid: {
        id: "mockID",
        name: "CustomGateway",
        version: [
          {
            Core: SATP_CORE_VERSION,
            Architecture: SATP_ARCHITECTURE_VERSION,
            Crash: SATP_CRASH_VERSION,
          },
        ],
        connectedDLTs: [
          { id: "BESU", ledgerType: LedgerType.Besu2X },
          { id: "FABRIC", ledgerType: LedgerType.Fabric2 },
        ],
        proofID: "mockProofID10",
        gatewayServerPort: 3014,
        gatewayClientPort: 3015,
        address: "https://localhost",
      },
      knexLocalConfig: knexClientConnection,
      knexRemoteConfig: knexSourceRemoteConnection,
    };
  
    const gateway = await factory.create(options);
    expect(gateway).toBeInstanceOf(SATPGateway);
  
    const satpManager = (gateway as any).BLODispatcher.manager;
    satpManager.getSessions().set(mockSession.getSessionId(), mockSession);

    let sessionState = false; // Initial state is false (pending)

    await gateway.startup();
  
    const initialSessionState = await satpManager.getSATPSessionState();
    expect(initialSessionState).toBe(false); // Ensure sessions are pending
    
    const shutdownPromise = gateway.shutdown();
  
    const getSATPSessionStateSpy = jest
      .spyOn(satpManager, "getSATPSessionState")
      .mockImplementation(async () => {
        if (!sessionState) {
          await new Promise((resolve) => setTimeout(resolve, 100)); 
          sessionState = true; // Change state to true after delay
        }
        return sessionState;
      });

    await shutdownPromise;

    const finalSessionState = await satpManager.getSATPSessionState();
    expect(finalSessionState).toBe(true); // Ensure sessions are completed
    
    expect(mockSession.getClientSessionData().state).toBe(
      SessionState.ONGOING,
    );

    getSATPSessionStateSpy.mockRestore();
  });
});

