import path from "node:path";
import { config } from "dotenv";

/**
 * The repo has one .env at its root, shared by docker compose, the SQL scripts
 * and this app. Next.js only reads .env files from web/, so the database
 * clients import this module to load the root file. Variables that are already
 * set (e.g. in production) are never overwritten.
 */
config({ path: path.resolve(process.cwd(), "..", ".env"), quiet: true });
