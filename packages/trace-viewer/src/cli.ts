#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  resolveLoopbackHost,
  startTraceViewer,
  TRACE_VIEWER_DEFAULT_HOST,
  TRACE_VIEWER_DEFAULT_PORT
} from "./server.js";

export interface TraceViewerCliOptions {
  ledgerPath?: string;
  spansPath?: string;
  host: string;
  port: number;
  help: boolean;
  version: boolean;
}

const HELP = `zhivex-trace-viewer

Read saved Zhivex governance ledgers and OpenTelemetry span files, then serve a local page.

Usage
  zhivex-trace-viewer --ledger <file-or-directory> [--spans <file-or-directory>] [--host 127.0.0.1] [--port 9473]

Options
  --ledger   Ledger JSON file or directory of .json/.jsonl inputs. Required.
  --spans    Optional extra span JSON or JSONL file or directory.
  --host     Loopback bind address. Default: ${TRACE_VIEWER_DEFAULT_HOST}. localhost binds as 127.0.0.1.
  --port     TCP port. Default: ${TRACE_VIEWER_DEFAULT_PORT}.
  --version  Print the package version.
  --help     Show this help.

The process listens only on 127.0.0.1 or ::1 and does not make outbound requests.
`;

const takeValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
};

/** Parse CLI arguments. Throws on unknown flags, missing values, or a non-loopback host. */
export const parseTraceViewerArgs = (argv: string[]): TraceViewerCliOptions => {
  const options: TraceViewerCliOptions = {
    host: TRACE_VIEWER_DEFAULT_HOST,
    port: TRACE_VIEWER_DEFAULT_PORT,
    help: false,
    version: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    const [flag, inline] = token.split("=", 2);
    const valueOf = (name: string) => {
      if (inline !== undefined) return inline;
      const value = takeValue(argv, index, name);
      index += 1;
      return value;
    };
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--version" || flag === "-v") options.version = true;
    else if (flag === "--ledger") options.ledgerPath = valueOf("--ledger");
    else if (flag === "--spans") options.spansPath = valueOf("--spans");
    else if (flag === "--host") options.host = resolveLoopbackHost(valueOf("--host"));
    else if (flag === "--port") {
      const raw = valueOf("--port");
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${raw}".`);
      options.port = port;
    } else {
      throw new Error(`Unknown argument "${token}".`);
    }
  }
  options.host = resolveLoopbackHost(options.host);
  return options;
};

const waitForSignal = () => new Promise<void>((resolve) => {
  const stop = () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    resolve();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});

export const runTraceViewerCli = async (
  argv: string[],
  packageVersion = "0.1.0",
  waitForStop: () => Promise<void> = waitForSignal
): Promise<number> => {
  let options: TraceViewerCliOptions;
  try {
    options = parseTraceViewerArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments.");
    console.error(HELP);
    return 1;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.version) {
    console.log(packageVersion);
    return 0;
  }
  if (!options.ledgerPath) {
    console.error("Missing --ledger.");
    console.error(HELP);
    return 1;
  }
  try {
    const viewer = await startTraceViewer({
      ledgerPath: options.ledgerPath,
      spansPath: options.spansPath,
      host: options.host,
      port: options.port
    });
    console.log(`Trace viewer listening on ${viewer.url}`);
    console.log(`${viewer.view.runs.length} run(s), ${viewer.view.warnings.length} warning(s).`);
    await waitForStop();
    await viewer.close();
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to start the trace viewer.");
    return 1;
  }
};

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const version = process.env.npm_package_version ?? "0.1.0";
  runTraceViewerCli(process.argv.slice(2), version).then((code) => {
    process.exitCode = code;
  });
}
