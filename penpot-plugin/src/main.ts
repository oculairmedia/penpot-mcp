import "./style.css";

// get the current theme from the URL
const searchParams = new URLSearchParams(window.location.search);
document.body.dataset.theme = searchParams.get("theme") ?? "light";

// WebSocket connection management
let ws: WebSocket | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
const PING_INTERVAL_MS = 30000; // Send ping every 30 seconds
const RECONNECT_DELAY_MS = 5000; // Wait 5 seconds before reconnecting
const statusElement = document.getElementById("connection-status");

/**
 * Updates the connection status display element.
 */
function updateConnectionStatus(status: string, isConnectedState: boolean): void {
    if (statusElement) {
        statusElement.textContent = status;
        statusElement.style.color = isConnectedState ? "var(--accent-primary)" : "var(--error-700)";
    }
}

/**
 * Starts the ping interval to keep the connection alive.
 */
function startPingInterval(): void {
    stopPingInterval();
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
            console.log("Sent ping to keep connection alive");
        }
    }, PING_INTERVAL_MS);
}

/**
 * Stops the ping interval.
 */
function stopPingInterval(): void {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

/**
 * Schedules a reconnection attempt.
 */
function scheduleReconnect(): void {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }
    reconnectTimeout = setTimeout(() => {
        console.log("Attempting to reconnect...");
        connectToMcpServer();
    }, RECONNECT_DELAY_MS);
}

/**
 * Sends a task response back to the MCP server via WebSocket.
 *
 * @param response - The response containing task ID and result
 */
function sendTaskResponse(response: any): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
        console.log("Sent response to MCP server:", response);
    } else {
        console.error("WebSocket not connected, cannot send response");
    }
}

/**
 * Establishes a WebSocket connection to the MCP server.
 */
function connectToMcpServer(): void {
    if (ws?.readyState === WebSocket.OPEN) {
        updateConnectionStatus("Already connected", true);
        return;
    }

    try {
        // Use dynamic WebSocket URL based on current page host (for reverse proxy/tunnel support)
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const wsUrl = `${protocol}//${host}/ws`;

        ws = new WebSocket(wsUrl);
        updateConnectionStatus("Connecting...", false);

        ws.onopen = () => {
            console.log("Connected to MCP server");
            updateConnectionStatus("Connected to MCP server", true);
            startPingInterval();
        };

        ws.onmessage = (event) => {
            console.log("Received from MCP server:", event.data);
            try {
                const message = JSON.parse(event.data);
                // Ignore pong responses
                if (message.type === "pong") {
                    return;
                }
                // Forward the task request to the plugin for execution
                parent.postMessage(message, "*");
            } catch (error) {
                console.error("Failed to parse WebSocket message:", error);
            }
        };

        ws.onclose = () => {
            console.log("Disconnected from MCP server");
            updateConnectionStatus("Disconnected - reconnecting...", false);
            stopPingInterval();
            ws = null;
            scheduleReconnect();
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            updateConnectionStatus("Connection error", false);
        };
    } catch (error) {
        console.error("Failed to connect to MCP server:", error);
        updateConnectionStatus("Connection failed", false);
    }
}

document.querySelector("[data-handler='connect-mcp']")?.addEventListener("click", () => {
    connectToMcpServer();
});

// Listen plugin.ts messages
window.addEventListener("message", (event) => {
    if (event.data.source === "penpot") {
        document.body.dataset.theme = event.data.theme;
    } else if (event.data.type === "task-response") {
        // Forward task response back to MCP server
        sendTaskResponse(event.data.response);
    }
});
