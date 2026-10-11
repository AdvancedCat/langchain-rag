/** API 服务地址（Vite 环境变量，见 .env.example；CORS 白名单默认放行 5173） */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
