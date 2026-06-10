/* ============================================================
   evo/prompt.js — tiny interactive prompts for the hand-run loop.

   The loop is run by a human at a terminal, so it may ASK: for the
   Anthropic API key when the live provider is chosen without one in the
   environment, and for confirmation to continue once the experiment's
   token max is reached. All prompts are TTY-gated — in a non-interactive
   context (CI, piped input) they resolve to a safe default and never
   hang.
   ============================================================ */
'use strict';
const readline = require('readline');

const isTTY = () => process.stdin.isTTY && process.stdout.isTTY;

function ask(question, { mask = false } = {}) {
  if (!isTTY()) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (mask) {
      // hide the typed key
      const onData = () => { rl.output.write('\x1b[2K\r' + question); };
      rl._writeToOutput = () => {}; // suppress echo
      rl.output.write(question);
      void onData;
    }
    rl.question(mask ? '' : question, (answer) => { rl.close(); if (mask) process.stdout.write('\n'); resolve(String(answer || '').trim()); });
  });
}

async function confirm(question, def = false) {
  if (!isTTY()) return def;
  const a = (await ask(question + (def ? ' [Y/n] ' : ' [y/N] '))).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
}

// Prompt for the Anthropic key when live is wanted but none is set. Returns
// the key (and sets it on the env for the SDK), or '' to fall back to offline.
async function promptApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!isTTY()) return '';
  const key = await ask('Anthropic API key for the live agent (press enter to run offline, zero-token): ', { mask: true });
  if (key) process.env.ANTHROPIC_API_KEY = key;
  return key;
}

module.exports = { ask, confirm, promptApiKey, isTTY };
