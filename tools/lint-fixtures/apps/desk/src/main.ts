import { readFileSync } from "node:fs";
import { api } from "../../../plugins/foo/src/api.js";
import { reactEntry } from "@loom/react";
export const okApp = [readFileSync, api, reactEntry];
