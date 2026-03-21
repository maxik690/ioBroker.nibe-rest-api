import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    root: __dirname,
    base: "./",
    plugins: [react()],
    build: {
        outDir: path.resolve(__dirname, "../admin"),
        emptyOutDir: false,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (!id.includes("node_modules")) {
                        return undefined;
                    }

                    if (id.includes("@iobroker/adapter-react-v5")) {
                        return "adapter-react";
                    }

                    if (id.includes("@mui/") || id.includes("@emotion/")) {
                        return "mui";
                    }

                    if (id.includes("react-dom") || id.includes("react/")) {
                        return "react-vendor";
                    }

                    return "vendor";
                },
            },
        },
    },
});
