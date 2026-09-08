export const config = {
  DATABASE_URL: process.env.DATABASE_URL || "postgresql://puerhub:TeaHub2026Secure@localhost:5432/puerhub",
  AUTH_SECRET: process.env.AUTH_SECRET || "puer-hub-prod-change-me",
  WS_PORT: parseInt(process.env.WS_PORT || "3003", 10),
  CORS_ORIGIN: process.env.CORS_ORIGIN || "https://puer.im",
};
