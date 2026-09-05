import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Vite 开发服务器：把 /api 请求代理到后端 8080，避免跨域问题
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:8081',
                changeOrigin: true,
            },
        },
    },
});
