import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createServerlessRuntimeHost,
  type ServerlessHostOptions,
  type ServerlessRuntimeHost,
} from "../src/runtime/serverless.js";

let defaultHost: ServerlessRuntimeHost = createServerlessRuntimeHost();

export function getServerlessHost(): ServerlessRuntimeHost {
  return defaultHost;
}

export async function resetServerlessHost(options?: ServerlessHostOptions): Promise<void> {
  await defaultHost.reset();
  defaultHost = createServerlessRuntimeHost(options);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await defaultHost.handleNodeRequest(req, res);
}
