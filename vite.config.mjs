import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    root: "client",
    plugins: [react()],
    build: {
        outDir: "../dist",
        emptyOutDir: true
    },
    server: {
        proxy: {
            "/api": `http://localhost:${process.env.PORT || 10000}`
        }
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./src/test/setup.jsx"],
        include: ["src/**/*.test.{js,jsx}"],
        css: { include: [/\.css/] }
    }
});
