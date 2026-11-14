#!/usr/bin/env node
import { runInit } from '../init-cli.js';
runInit(process.argv.slice(2)).then(r=>{ if(r && r.ok===false) process.exitCode=2; }).catch(e=>{ console.error(e); process.exit(1); });
