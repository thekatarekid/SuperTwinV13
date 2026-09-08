import { appendFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { withTraceDbLock } from "./store.js";

const [dbFile, file, value, holdRaw = "0", ready] = process.argv.slice(2);
if (!dbFile || !file || value === undefined) throw new Error("db, file and value required");
const db = new Database(dbFile);
db.pragma("busy_timeout = 5000");
withTraceDbLock(db, () => {
  if (ready) writeFileSync(ready, "ready", "utf8");
  const hold = Number(holdRaw);
  if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
  appendFileSync(file, `${value}\n`, "utf8");
});
db.close();
