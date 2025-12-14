import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ExecuteCodeTool } from "./tools/ExecuteCodeTool";
import { PluginBridge } from "./PluginBridge";
import { ConfigurationLoader } from "./ConfigurationLoader";
import { createLogger } from "./logger";
import { Tool } from "./Tool";
import { HighLevelOverviewTool } from "./tools/HighLevelOverviewTool";
import { PenpotApiInfoTool } from "./tools/PenpotApiInfoTool";
import { ExportShapeTool } from "./tools/ExportShapeTool";
import { ImportImageTool } from "./tools/ImportImageTool";
import { ReplServer } from "./ReplServer";
import { ApiDocs } from "./ApiDocs";

/**
 * In-memory event store for MCP response tracking.
 * Required for StreamableHTTPServerTransport to properly deliver responses.
 */
class InMemoryEventStore {
    private events: Map<string, { streamId: string; message: unknown; timestamp: number }> = new Map();
    private readonly maxAge: number = 3600000; // 1 hour
    private readonly maxEventsPerStream: number = 1000;

    generateEventId(streamId: string): string {
        return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }

    getStreamIdFromEventId(eventId: string): string {
        const parts = eventId.split("_");
        return parts.length > 0 ? parts[0] : "";
    }

    async storeEvent(streamId: string, message: unknown): Promise<string> {
        const eventId = this.generateEventId(streamId);
        this.events.set(eventId, {
            streamId,
            message,
            timestamp: Date.now(),
        });
        this.cleanupOldEvents();
        return eventId;
    }

    private cleanupOldEvents(): void {
        const now = Date.now();
        const streamEventCounts = new Map<string, number>();

        for (const [eventId, event] of this.events.entries()) {
            if (now - event.timestamp > this.maxAge) {
                this.events.delete(eventId);
                continue;
            }

            const count = streamEventCounts.get(event.streamId) || 0;
            streamEventCounts.set(event.streamId, count + 1);
        }

        for (const [streamId, count] of streamEventCounts.entries()) {
            if (count > this.maxEventsPerStream) {
                const streamEvents = [...this.events.entries()]
                    .filter(([, event]) => event.streamId === streamId)
                    .sort((a, b) => a[1].timestamp - b[1].timestamp);

                const toRemove = count - this.maxEventsPerStream;
                for (let i = 0; i < toRemove; i++) {
                    this.events.delete(streamEvents[i][0]);
                }
            }
        }
    }

    getEventCount(): number {
        return this.events.size;
    }

    async replayEventsAfter(
        lastEventId: string,
        { send }: { send: (eventId: string, message: unknown) => Promise<void> }
    ): Promise<string> {
        if (!lastEventId || !this.events.has(lastEventId)) {
            return "";
        }

        const streamId = this.getStreamIdFromEventId(lastEventId);
        if (!streamId) {
            return "";
        }

        let foundLastEvent = false;

        const sortedEvents = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        for (const [eventId, { streamId: eventStreamId, message }] of sortedEvents) {
            if (eventStreamId !== streamId) {
                continue;
            }

            if (eventId === lastEventId) {
                foundLastEvent = true;
                continue;
            }

            if (foundLastEvent) {
                await send(eventId, message);
            }
        }
        return streamId;
    }
}

export class PenpotMcpServer {
    private readonly logger = createLogger("PenpotMcpServer");
    private readonly server: McpServer;
    private readonly tools: Map<string, Tool<any>>;
    public readonly configLoader: ConfigurationLoader;
    private app: any;
    public readonly pluginBridge: PluginBridge;
    private readonly replServer: ReplServer;
    private apiDocs: ApiDocs;

    private readonly transports = {
        streamable: {} as Record<string, StreamableHTTPServerTransport>,
        sse: {} as Record<string, SSEServerTransport>,
    };
    private readonly eventStores = new Map<string, InMemoryEventStore>();

    constructor(
        private port: number = 4401,
        private webSocketPort: number = 4402,
        replPort: number = 4403
    ) {
        this.configLoader = new ConfigurationLoader();
        this.apiDocs = new ApiDocs();

        this.server = new McpServer(
            {
                name: "penpot-mcp-server",
                version: "1.0.0",
            },
            {
                instructions: this.getInitialInstructions(),
            }
        );

        this.tools = new Map<string, Tool<any>>();
        this.pluginBridge = new PluginBridge(webSocketPort);
        this.replServer = new ReplServer(this.pluginBridge, replPort);

        this.registerTools();
    }

    public getInitialInstructions(): string {
        let instructions = this.configLoader.getInitialInstructions();
        instructions = instructions.replace("$api_types", this.apiDocs.getTypeNames().join(", "));
        return instructions;
    }

    private registerTools(): void {
        const toolInstances: Tool<any>[] = [
            new ExecuteCodeTool(this),
            new HighLevelOverviewTool(this),
            new PenpotApiInfoTool(this, this.apiDocs),
            new ExportShapeTool(this),
            new ImportImageTool(this),
        ];

        for (const tool of toolInstances) {
            const toolName = tool.getToolName();
            this.tools.set(toolName, tool);

            // Register each tool with McpServer
            this.logger.info(`Registering tool: ${toolName}`);
            this.server.registerTool(
                toolName,
                {
                    description: tool.getToolDescription(),
                    inputSchema: tool.getInputSchema(),
                },
                async (args) => {
                    return tool.execute(args);
                }
            );
        }
    }

    private setupHttpEndpoints(): void {
        // POST handler for MCP requests
        this.app.post("/mcp", async (req: any, res: any) => {
            const { randomUUID } = await import("node:crypto");

            try {
                const sessionId = req.headers["mcp-session-id"] as string | undefined;
                const method = req.body?.method || "unknown";
                this.logger.info(`MCP POST request: method=${method}, sessionId=${sessionId || "none"}, isInit=${isInitializeRequest(req.body)}`);

                let transport: StreamableHTTPServerTransport | undefined;

                if (sessionId && this.transports.streamable[sessionId]) {
                    // Existing session
                    this.logger.info(`Using existing session: ${sessionId}`);
                    transport = this.transports.streamable[sessionId];
                } else if (!sessionId && isInitializeRequest(req.body)) {
                    // New session - create event store and transport
                    const eventStore = new InMemoryEventStore();
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        eventStore,
                        onsessioninitialized: (id: string) => {
                            this.logger.info(`Session initialized with ID: ${id}`);
                            this.transports.streamable[id] = transport as StreamableHTTPServerTransport;
                            this.eventStores.set(id, eventStore);
                        },
                    });

                    transport.onclose = () => {
                        const sid = transport?.sessionId;
                        if (sid && this.transports.streamable[sid]) {
                            this.logger.info(`Transport closed for session ${sid}`);
                            delete this.transports.streamable[sid];
                            this.eventStores.delete(sid);
                        }
                    };

                    await this.server.connect(transport);
                    this.logger.info(`Handling initialize request for new session`);
                    await transport.handleRequest(req, res, req.body);
                    this.logger.info(`Initialize request handled`);
                    return;
                } else {
                    // No valid session
                    res.status(400).json({
                        jsonrpc: "2.0",
                        error: {
                            code: -32000,
                            message: "Bad Request: No valid session ID provided",
                        },
                        id: null,
                    });
                    return;
                }

                this.logger.info(`Handling request for existing session`);
                await transport.handleRequest(req, res, req.body);
                this.logger.info(`Request handled for existing session, headersSent=${res.headersSent}`);
            } catch (error) {
                this.logger.error(error, "Error handling MCP request");
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: "2.0",
                        error: {
                            code: -32603,
                            message: "Internal server error",
                        },
                        id: null,
                    });
                }
            }
        });

        // GET handler for SSE streams
        this.app.get("/mcp", async (req: any, res: any) => {
            const sessionId = req.headers["mcp-session-id"] as string | undefined;

            if (!sessionId || !this.transports.streamable[sessionId]) {
                return res.status(400).send("Session ID required");
            }

            const transport = this.transports.streamable[sessionId];
            await transport.handleRequest(req, res);
        });

        // DELETE handler for session termination
        this.app.delete("/mcp", async (req: any, res: any) => {
            const sessionId = req.headers["mcp-session-id"] as string | undefined;

            if (!sessionId) {
                return res.status(400).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Bad Request: No session ID provided",
                    },
                });
            }

            if (!this.transports.streamable[sessionId]) {
                return res.status(404).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32001,
                        message: "Session not found",
                    },
                });
            }

            try {
                const transport = this.transports.streamable[sessionId];
                if (transport.onclose) {
                    transport.onclose();
                }
                delete this.transports.streamable[sessionId];
                this.eventStores.delete(sessionId);

                this.logger.info(`Session ${sessionId} terminated by client`);
                res.status(200).json({
                    jsonrpc: "2.0",
                    result: { terminated: true },
                });
            } catch (error) {
                this.logger.error(error, `Error terminating session ${sessionId}`);
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32603,
                        message: "Internal server error during session termination",
                    },
                });
            }
        });

        this.app.get("/sse", async (_req: any, res: any) => {
            const transport = new SSEServerTransport("/messages", res);
            this.transports.sse[transport.sessionId] = transport;

            res.on("close", () => {
                delete this.transports.sse[transport.sessionId];
            });

            await this.server.connect(transport);
        });

        this.app.post("/messages", async (req: any, res: any) => {
            const sessionId = req.query.sessionId as string;
            const transport = this.transports.sse[sessionId];

            if (transport) {
                await transport.handlePostMessage(req, res, req.body);
            } else {
                res.status(400).send("No transport found for sessionId");
            }
        });
    }

    async start(): Promise<void> {
        const { default: express } = await import("express");
        this.app = express();
        this.app.use(express.json());

        this.setupHttpEndpoints();

        return new Promise((resolve) => {
            this.app.listen(this.port, async () => {
                this.logger.info(`Penpot MCP Server started on port ${this.port}`);
                this.logger.info(`Modern Streamable HTTP endpoint: http://localhost:${this.port}/mcp`);
                this.logger.info(`Legacy SSE endpoint: http://localhost:${this.port}/sse`);
                this.logger.info(`WebSocket server is on ws://localhost:${this.webSocketPort}`);

                // start the REPL server
                await this.replServer.start();

                resolve();
            });
        });
    }

    /**
     * Stops the MCP server and associated services.
     *
     * Gracefully shuts down the REPL server and other components.
     */
    public async stop(): Promise<void> {
        this.logger.info("Stopping Penpot MCP Server...");
        await this.replServer.stop();
        this.logger.info("Penpot MCP Server stopped");
    }
}
