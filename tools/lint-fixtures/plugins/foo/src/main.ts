import { readFileSync } from "node:fs";
import { createKernel } from "@loom/sdk";
import { reactEntry } from "@loom/react";
import { api } from "./api.js";
export const okMain = [readFileSync, createKernel, reactEntry, api];
