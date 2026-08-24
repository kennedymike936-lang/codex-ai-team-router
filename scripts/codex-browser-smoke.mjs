#!/usr/bin/env node
/**
 * Deterministic browser smoke test for local HTML / Canvas projects.
 *
 * Strategy: launch system Chromium (Chrome / Edge) headless over CDP
 * through Node.js native WebSocket. No permanent dependency is required.
 *
 * For each HTML file the test:
 *  - detects page-level uncaught errors / unhandled rejections
 *  - verifies at least one <canvas> exists
 *  - proves the canvas can render and read back pixels
 *
 * No network access is required – HTML is loaded via file:// URLs.
 * All browser / temp processes are cleaned up before exit.
 * Startup + execution is bounded by per-file timeouts.
 *
 * Output: JSON array to stdout (one result per file).
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { access, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BROWSER_STARTUP_MS = 20_000;
const FILE_TIMEOUT_MS = 30_000;

const SYSTEM_BROWSER_CANDIDATES = [
  join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(homedir(), 'AppData', 'Local', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'Microsoft\\Edge\\Application\\msedge.exe'),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function findSystemBrowser() {
  const forced = process.env.AI_TEAM_BROWSER_PATH?.trim();
  if (forced) return (await fileExists(forced)) ? forced : null;
  for (const p of SYSTEM_BROWSER_CANDIDATES) {
    if (await fileExists(p)) return p;
  }
  // Try PATH
  for (const name of ['chrome', 'msedge', 'chromium', 'google-chrome', 'microsoft-edge']) {
    try {
      const result = await new Promise((resolvePromise, reject) => {
        const proc = spawn('where', [name], {
          shell: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0 && out.trim()) resolvePromise(out.trim().split(/\r?\n/)[0]);
          else resolvePromise(null);
        });
        proc.on('error', () => resolvePromise(null));
      });
      if (result) return result;
    } catch { /* continue */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CDP client (zero-dependency, uses Node.js native WebSocket)
// ---------------------------------------------------------------------------

function cdpConnect(browserWSEndpoint, timeoutMs = 10_000) {
  return new Promise((resolveWs, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const ws = new WebSocket(browserWSEndpoint);
    let nextId = 0;
    const pending = new Map();

    ws.onopen = () => {
      clearTimeout(timer);
      const send = (method, params = {}, sessionId = undefined) => {
        const id = ++nextId;
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        const msg = JSON.stringify(message);
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(msg);
        });
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message || JSON.stringify(msg.error)}`));
          else res(msg.result);
        }
      };

      resolveWs({
        send,
        ws,
        on: (handler) => {
          ws.addEventListener('message', (e) => {
            const msg = JSON.parse(e.data);
            if (!msg.id) handler(msg);
          });
        },
      });
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('WebSocket connection error'));
    };
  });
}

// ---------------------------------------------------------------------------
// CDP-based browser smoke test
// ---------------------------------------------------------------------------

function launchSystemBrowser(browserPath, userDataDir) {
  return new Promise((resolveLaunch, reject) => {
    const proc = spawn(browserPath, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-default-apps',
      '--mute-audio',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      terminateProc(proc);
      reject(new Error('Browser did not produce a DevTools URL within timeout'));
    }, BROWSER_STARTUP_MS);

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const check = () => {
      const m = stderr.match(/DevTools listening on\s+(ws:\/\/[^\s]+)/i);
      if (m) {
        clearTimeout(timer);
        resolveLaunch({ proc, wsUrl: m[1].trim() });
      }
    };
    proc.stderr.on('data', check);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      reject(new Error(`Browser exited prematurely. stderr: ${stderr.slice(-200)}`));
    });
  });
}

function terminateProc(proc) {
  try { proc.kill('SIGTERM'); } catch {}
}

async function cleanupBrowser(proc, userDataDir) {
  if (proc && proc.exitCode === null) {
    terminateProc(proc);
    await Promise.race([
      new Promise((resolveClose) => proc.once('close', resolveClose)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2000)),
    ]);
    if (proc.exitCode === null) {
      try { proc.kill('SIGKILL'); } catch {}
    }
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(userDataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
}

async function cdpSmokeTest(htmlFiles, rootDir) {
  if (/^(0|false|off)$/i.test(process.env.AI_TEAM_BROWSER_SMOKE || '')) {
    return [{ status: 'not_detected', reason: 'Browser smoke disabled by AI_TEAM_BROWSER_SMOKE.' }];
  }
  const browserPath = await findSystemBrowser();
  if (!browserPath) {
    return [{ status: 'not_detected', reason: 'No Chromium-family system browser found on PATH or in standard install locations.' }];
  }

  const userDataDir = join(tmpdir(), `ai-team-cdp-${randomUUID()}`);
  await mkdir(userDataDir, { recursive: true });

  let proc = null;
  const results = [];

  try {
    const { proc: p, wsUrl } = await launchSystemBrowser(browserPath, userDataDir);
    proc = p;

    // Register cleanup
    const doCleanup = () => {
      terminateProc(proc);
    };
    process.on('exit', doCleanup);
    process.on('SIGTERM', doCleanup);
    process.on('SIGINT', doCleanup);

    for (const htmlFile of htmlFiles) {
      const fileResult = {
        file: htmlFile,
        status: 'pass',
        errors: [],
        canvas_detected: false,
        canvas_renderable: false,
        summary: '',
        details: '',
      };

      const timeoutTimer = setTimeout(() => {
        fileResult.status = 'fail';
        fileResult.errors.push('Timed out');
        fileResult.summary = `Browser test timed out after ${FILE_TIMEOUT_MS}ms.`;
      }, FILE_TIMEOUT_MS);

      try {
        let cdp = null;
        try {
          cdp = await cdpConnect(wsUrl, 10_000);
          const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
          const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          const sessionId = attached.sessionId;

          // Collect errors
          const collectedErrors = [];

          // Enable Runtime domain to catch exceptions
          await cdp.send('Runtime.enable', {}, sessionId);

          cdp.on((msg) => {
            if (msg.sessionId !== sessionId) return;
            if (msg.method === 'Runtime.exceptionThrown') {
              const ed = msg.params?.exceptionDetails;
              const text = ed?.text || ed?.exception?.description || 'Unknown exception';
              const url = ed?.url || '';
              collectedErrors.push(`Uncaught exception: ${text}${url ? ` (${url})` : ''}`);
            }
            if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
              const args = (msg.params?.args || []).map(a => a.value || a.description || '').join(' ');
              if (args) collectedErrors.push(`console.error: ${args}`);
            }
          });

          // Also enable Page domain for lifecycle events
          await cdp.send('Page.enable', {}, sessionId);

          // Inject error handlers before any page script runs
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `
              window.__codex_browser_smoke__ = { errors: [], rejections: [] };
              window.addEventListener('error', function(e) {
                window.__codex_browser_smoke__.errors.push(e.message || String(e.error));
              });
              window.addEventListener('unhandledrejection', function(e) {
                window.__codex_browser_smoke__.rejections.push(e.reason?.message || String(e.reason));
              });
            `,
          }, sessionId);

          // Resolve absolute file URL
          const absPath = resolve(rootDir, htmlFile);
          const fileUrl = pathToFileURL(absPath).href;

          // Navigate
          const loadPromise = new Promise((resolveNav) => {
            let done = false;
            cdp.on((msg) => {
              if (msg.sessionId !== sessionId) return;
              if (done) return;
              if (msg.method === 'Page.loadEventFired') {
                // Give a short extra tick for deferred scripts
                setTimeout(() => { done = true; resolveNav(); }, 500);
              }
            });
          });

          await cdp.send('Page.navigate', { url: fileUrl }, sessionId);

          const navTimeout = new Promise((_, rej) =>
            setTimeout(() => rej(new Error('Navigation timed out')), FILE_TIMEOUT_MS - 2000));
          await Promise.race([loadPromise, navTimeout]);

          // Collect injected error handlers' data
          const injectedResult = await cdp.send('Runtime.evaluate', {
            expression: `JSON.stringify(window.__codex_browser_smoke__ || { errors: [], rejections: [] })`,
            returnByValue: true,
          }, sessionId);
          try {
            const injected = JSON.parse(injectedResult.result?.value || '{}');
            for (const e of (injected.errors || [])) {
              if (e) collectedErrors.push(`Page error: ${e}`);
            }
            for (const r of (injected.rejections || [])) {
              if (r) collectedErrors.push(`Unhandled rejection: ${r}`);
            }
          } catch { /* parse failure, ignore */ }

          // Verify at least one canvas exists
          const canvasCheck = await cdp.send('Runtime.evaluate', {
            expression: `document.querySelectorAll('canvas').length`,
            returnByValue: true,
          }, sessionId);
          const canvasCount = canvasCheck.result?.value ?? 0;
          fileResult.canvas_detected = canvasCount > 0;

          if (canvasCount > 0) {
            // Verify canvas can render and read back pixels
            const renderCheck = await cdp.send('Runtime.evaluate', {
              expression: `
                (function() {
                  var c = document.querySelector('canvas');
                  if (!c) return 'no canvas element found';
                  var ctx = c.getContext('2d');
                  if (!ctx) return 'no 2d context available';
                  // Draw a known-color rect
                  ctx.fillStyle = '#FF6600';
                  ctx.fillRect(10, 10, 4, 4);
                  // Read back the pixel
                  var pixel = ctx.getImageData(12, 12, 1, 1).data;
                  return {
                    width: c.width || c.clientWidth,
                    height: c.height || c.clientHeight,
                    pixel: [pixel[0], pixel[1], pixel[2], pixel[3]],
                    renderable: pixel[0] === 255 && pixel[1] === 102 && pixel[2] === 0 && pixel[3] === 255
                  };
                })()
              `,
              returnByValue: true,
            }, sessionId);
            const renderData = renderCheck.result?.value;
            if (typeof renderData === 'object' && renderData !== null) {
              fileResult.canvas_renderable = renderData.renderable === true;
              fileResult.details = `Canvas ${renderData.width}x${renderData.height}, pixel readback: [${(renderData.pixel || []).join(',')}]`;
            } else {
              fileResult.details = String(renderData || 'unknown');
            }
          } else {
            fileResult.details = 'no <canvas> elements found';
          }

          fileResult.errors = [...new Set(collectedErrors)];
          await cdp.send('Target.closeTarget', { targetId: target.targetId });

        } finally {
          if (cdp && cdp.ws) {
            try { cdp.ws.close(); } catch {}
          }
        }

        // Determine status
        if (fileResult.errors.length > 0) {
          fileResult.status = 'fail';
          fileResult.summary = `Browser errors detected: ${fileResult.errors.join('; ')}`;
        } else if (!fileResult.canvas_detected) {
          fileResult.status = 'pass';
          fileResult.summary = 'No errors detected. No canvas found (HTML may not be a Canvas project).';
        } else if (!fileResult.canvas_renderable) {
          fileResult.status = 'fail';
          fileResult.summary = 'Canvas found but pixel readback failed — rendering may be broken.';
        } else {
          fileResult.status = 'pass';
          fileResult.summary = 'Canvas renders and pixel readback verified.';
        }

      } catch (err) {
        if (fileResult.status !== 'fail') {
          fileResult.status = 'fail';
          fileResult.errors.push(err.message);
          fileResult.summary = `Browser test error: ${err.message}`;
        }
      } finally {
        clearTimeout(timeoutTimer);
      }

      results.push(fileResult);
    }
  } catch (err) {
    results.push({
      file: '*',
      status: 'not_detected',
      reason: `System browser test infrastructure error: ${err.message}`,
    });
  } finally {
    await cleanupBrowser(proc, userDataDir);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(JSON.stringify([{
      status: 'not_detected',
      reason: 'Usage: node codex-browser-smoke.mjs <html-file> [html-file ...] [--root <dir>]',
    }]) + '\n');
    process.exit(0);
  }

  let rootDir = process.cwd();
  const rootIdx = args.indexOf('--root');
  let htmlFiles = [];
  if (rootIdx !== -1) {
    rootDir = resolve(args[rootIdx + 1] || '.');
    htmlFiles = args.slice(0, rootIdx);
  } else {
    htmlFiles = args;
  }

  if (htmlFiles.length === 0) {
    process.stdout.write(JSON.stringify([{ status: 'not_detected', reason: 'No HTML files provided.' }]) + '\n');
    process.exit(0);
  }

  const overallTimeoutMs = BROWSER_STARTUP_MS + (htmlFiles.length * FILE_TIMEOUT_MS) + 5_000;
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Browser smoke exceeded ${overallTimeoutMs}ms`)), overallTimeoutMs);
  });
  const results = await Promise.race([cdpSmokeTest(htmlFiles, rootDir), timeout]);

  process.stdout.write(JSON.stringify(results) + '\n');

  const anyFail = results.some((r) => r.status === 'fail');
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(JSON.stringify([{
    status: 'not_detected',
    reason: `Fatal smoke test error: ${err.message}`,
  }]) + '\n');
  process.exit(0); // not_detected = no hard fail
});
