import { Pool } from "pg";
import { config } from "./config";

export const pool = new Pool({ connectionString: config.DATABASE_URL });

pool.query("SELECT 1").catch((err: Error) => {
  console.error("Database connection failed:", err);
  process.exit(1);
});
