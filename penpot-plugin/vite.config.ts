import { defineConfig } from "vite";
import livePreview from "vite-live-preview";

export default defineConfig({
    plugins: [
        livePreview({
            reload: true,
            config: {
                build: {
                    sourcemap: true,
                },
            },
        }),
    ],
    build: {
        rollupOptions: {
            input: {
                plugin: "src/plugin.ts",
                index: "./index.html",
            },
            output: {
                entryFileNames: "[name].js",
            },
        },
    },
    preview: {
        port: 4400,
        host: '0.0.0.0',
        cors: true,
        allowedHosts: ['penpot-mcp.oculair.ca', 'penpotmcp.oculair.ca', 'localhost', '192.168.50.80'],
    },
});
