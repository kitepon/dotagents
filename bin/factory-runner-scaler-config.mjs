#!/usr/bin/env node
// Prints the runner scaler config for one seat from FACTORY_RUNNERS. Usage: factory-runner-scaler-config.mjs <label> <log path>
// Contract: docs/feature-map/runner-capacity.md. The host apply step writes the output next to the installed scaler.
import { FACTORY_RUNNERS } from '../lib/factory/deployment-contract.mjs';

const [label, log] = process.argv.slice(2);
const seat = FACTORY_RUNNERS.find((runner) => runner.label === label);
if (!seat || !log) { console.error('usage: factory-runner-scaler-config.mjs <seat label> <log path>'); process.exit(1); }
const { jobGiB, reserveGiB, maxLoadPerCpu, maxRunning, instances } = seat;
console.log(JSON.stringify({ label, jobGiB, reserveGiB, maxLoadPerCpu, maxRunning, log, instances }));
