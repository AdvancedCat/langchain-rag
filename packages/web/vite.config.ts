import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        // 5173 是 api 包 CORS 白名单（RAG_API_CORS_ORIGINS）的默认预设端口
        port: 5173,
    },
});
