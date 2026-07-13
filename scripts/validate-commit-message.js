#!/usr/bin/env node

import fs from "node:fs";
import { validateReleaseMessage } from "./changelog-message.js";

const messagePath = process.argv[2];
if (!messagePath) {
  console.error("Commit message file path is required");
  process.exit(2);
}

const errors = validateReleaseMessage(fs.readFileSync(messagePath, "utf8"));
if (errors.length) {
  console.error("Commit rejected: the changelog would be incomplete.\n");
  for (const error of errors) console.error(error);
  process.exit(1);
}
