#!/usr/bin/env node
import fs from 'node:fs';
import { render } from 'ink';
import React from 'react';
import { App } from './app.js';
import { defaultCtx } from './core.js';

const arg = process.argv[2];
if (arg === '-v' || arg === '--version') {
  console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else if (arg === '-h' || arg === '--help' || arg) {
  console.log(`s-kill — AI agent skill manager (TUI)

Usage: s-kill            show global and project skills for the current folder
       s-kill --version

Trash: ~/.s-kill/trash (override with S_KILL_TRASH)
Keys:  press ? inside the app`);
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('s-kill: must be run in an interactive terminal (TTY).');
  process.exit(1);
} else {
  render(<App ctx={defaultCtx()} />, { alternateScreen: true });
}
