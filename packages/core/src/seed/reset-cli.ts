/**
 * `npm run seed:reset`: re-creates the seeded demo conversations with dates
 * relative to today. Leaves non-seeded (real) conversations untouched.
 */
import { loadConfig, loadDotEnv } from "../shared/config";
import { openDatabase } from "../db/connection";
import { createRepositories } from "../db/repositories";
import { resetDemoData } from "./demo";

loadDotEnv();
const cfg = loadConfig();
const db = openDatabase(cfg.databasePath);
const n = resetDemoData(createRepositories(db), db, { timezone: cfg.timezone });
db.close();
console.log(`Re-seeded ${n} demo conversations (timezone ${cfg.timezone}) into ${cfg.databasePath}`);
