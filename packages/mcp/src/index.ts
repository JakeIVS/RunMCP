import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CoachService, FileRunnerRepository } from "@runmcp/service";
import { createRunMcpServer } from "./server.js";

const repository = new FileRunnerRepository(
  process.env.RUNMCP_LOCAL_STATE_PATH || ".runmcp-local.json",
);
const server = createRunMcpServer(
  new CoachService(repository),
  {
    subject: process.env.RUNMCP_LOCAL_SUBJECT || "local-runner",
    displayName: process.env.RUNMCP_LOCAL_NAME || "Local Runner",
    provider: "development",
    clientId: "stdio-local-agent",
  },
);
await server.connect(new StdioServerTransport());
