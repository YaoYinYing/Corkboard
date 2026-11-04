#!/usr/bin/env node
// Places migrations next to the compiled adapter (dist/migrations) so the built
// db.js resolves them relative to its module instead of the process cwd.
import { cpSync } from "node:fs";
import { join } from "node:path";

cpSync(
  join(process.cwd(), "migrations"),
  join(process.cwd(), "dist", "migrations"),
  { recursive: true },
);
