#!/usr/bin/env node
/**
 * Kie.ai provider stub for the Phase 1 certification load test.
 *
 * Stands in for api.kie.ai so the run can exercise generation quote/start,
 * webhook bursts and completion draining without billing real generations.
 * Reached through the `KIE_API_BASE_URL` seam in src/lib/provider-fetch.ts.
 *
 * It is deliberately faithful on three things, because the app's behaviour
 * depends on them:
 *
 * - `createTask` returns `{ code, data: { taskId } }`; the app reads
 *   `data.data.taskId` and nothing else.
 * - Status polls return `successFlag` (1 success, 2/3 failure) and a
 *   `resultJson` *string*, which is what the sync path JSON.parses.
 * - Completion callbacks go to the `callBackUrl` the app supplied, which
 *   carries the provider secret and the generationId. That URL points at the
 *   real Supabase edge function, so the burst travels the true production path:
 *   stub -> kie-webhook -> HMAC-signed forward -> /api/webhooks/kie.
 *
 * Failure injection exists so the run can drive F14's circuit breaker and the
 * "provider 429/5xx below 1-2%" criterion rather than assuming a perfect
 * provider, which is the one thing a stub would otherwise flatter.
 *
 * Usage:
 *   node scripts/certification/provider-stub.mjs --port 8787
 *   curl -X POST localhost:8787/stub/burst -d '{"count":500}'
 *   curl localhost:8787/stub/stats
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const options = {
  port: 8787,
  /** Seconds before a task is auto-completed. 0 disables auto-completion. */
  completionDelaySeconds: 8,
  /** Fraction of createTask calls answered 429. */
  rateLimitRate: 0,
  /** Fraction of createTask calls answered 5xx. */
  serverErrorRate: 0,
  publicUrl: null,
};

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument === '--port') { options.port = Number(value); index += 1; }
  else if (argument === '--completion-delay') { options.completionDelaySeconds = Number(value); index += 1; }
  else if (argument === '--rate-limit-rate') { options.rateLimitRate = Number(value); index += 1; }
  else if (argument === '--server-error-rate') { options.serverErrorRate = Number(value); index += 1; }
  else if (argument === '--public-url') { options.publicUrl = value; index += 1; }
}

/** taskId -> { callbackUrl, createdAt, state, generationId } */
const tasks = new Map();

const stats = {
  createTask: 0,
  statusPoll: 0,
  chatCompletion: 0,
  rateLimited: 0,
  serverErrors: 0,
  callbacksSent: 0,
  callbackFailures: 0,
  mediaServed: 0,
};

function mediaBaseUrl() {
  return options.publicUrl ?? `http://127.0.0.1:${options.port}`;
}

function json(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * The result payload the app parses out of `resultJson`. Media URLs point back
 * at this stub so the import path does real work — the host must be present in
 * the certification environment's MEDIA_IMPORT_HOST_ALLOWLIST or the import
 * refuses it, which is the correct behaviour and worth seeing under load.
 */
function buildResultJson(taskId, kind) {
  const extension = kind === 'video' ? 'mp4' : 'jpg';
  return JSON.stringify({
    resultUrls: [`${mediaBaseUrl()}/media/${taskId}.${extension}`],
  });
}

function taskKind(task) {
  return task?.kind ?? 'image';
}

async function sendCompletionCallback(taskId) {
  const task = tasks.get(taskId);
  if (!task || task.state !== 'pending' || !task.callbackUrl) return;

  task.state = 'completed';
  const body = JSON.stringify({
    code: 200,
    msg: 'success',
    data: {
      taskId,
      successFlag: 1,
      resultJson: buildResultJson(taskId, taskKind(task)),
    },
  });

  try {
    const response = await fetch(task.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    stats.callbacksSent += 1;
    if (!response.ok) {
      stats.callbackFailures += 1;
      task.lastCallbackStatus = response.status;
    }
  } catch (error) {
    stats.callbackFailures += 1;
    task.lastCallbackError = error.message;
  }
}

function scheduleCompletion(taskId) {
  if (options.completionDelaySeconds <= 0) return;
  setTimeout(() => { void sendCompletionCallback(taskId); }, options.completionDelaySeconds * 1000)
    .unref?.();
}

function registerTask(payload) {
  const taskId = `cert-${randomUUID()}`;
  const callbackUrl = typeof payload.callBackUrl === 'string' ? payload.callBackUrl : null;
  const model = typeof payload.model === 'string' ? payload.model : '';
  tasks.set(taskId, {
    callbackUrl,
    createdAt: Date.now(),
    state: 'pending',
    kind: /video|veo|kling|seedance|motion/i.test(model) ? 'video' : 'image',
  });
  scheduleCompletion(taskId);
  return taskId;
}

/** Fires the oldest pending callbacks all at once — the webhook-burst case. */
async function fireBurst(count) {
  const pending = [...tasks.entries()]
    .filter(([, task]) => task.state === 'pending' && task.callbackUrl)
    .slice(0, count)
    .map(([taskId]) => taskId);

  await Promise.all(pending.map((taskId) => sendCompletionCallback(taskId)));
  return pending.length;
}

const IMAGE_BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://127.0.0.1:${options.port}`);
  const { pathname } = url;

  // --- stub control plane -------------------------------------------------
  if (pathname === '/stub/stats') {
    const pending = [...tasks.values()].filter((task) => task.state === 'pending').length;
    return json(response, 200, { ...stats, tasksTotal: tasks.size, tasksPending: pending });
  }

  if (pathname === '/stub/burst' && request.method === 'POST') {
    const body = await readBody(request);
    const fired = await fireBurst(Number(body.count) || 100);
    return json(response, 200, { fired });
  }

  if (pathname === '/stub/reset' && request.method === 'POST') {
    tasks.clear();
    for (const key of Object.keys(stats)) stats[key] = 0;
    return json(response, 200, { ok: true });
  }

  // --- media, for realistic ingest ---------------------------------------
  if (pathname.startsWith('/media/')) {
    stats.mediaServed += 1;
    const isVideo = pathname.endsWith('.mp4');
    response.writeHead(200, {
      'Content-Type': isVideo ? 'video/mp4' : 'image/jpeg',
      'Content-Length': IMAGE_BYTES.length,
    });
    return response.end(IMAGE_BYTES);
  }

  // --- provider surface ---------------------------------------------------
  const isTaskCreate = request.method === 'POST'
    && (pathname === '/api/v1/jobs/createTask'
      || pathname === '/api/v1/veo/generate'
      || pathname === '/api/v1/playground/createAsset');

  if (isTaskCreate) {
    stats.createTask += 1;

    if (Math.random() < options.rateLimitRate) {
      stats.rateLimited += 1;
      return json(response, 429, { code: 429, msg: 'rate limited' }, { 'Retry-After': '2' });
    }
    if (Math.random() < options.serverErrorRate) {
      stats.serverErrors += 1;
      return json(response, 503, { code: 503, msg: 'upstream unavailable' });
    }

    const payload = await readBody(request);
    const taskId = registerTask(payload);
    return json(response, 200, { code: 200, msg: 'success', data: { taskId } });
  }

  const isStatusPoll = request.method === 'GET'
    && (pathname === '/api/v1/jobs/recordInfo'
      || pathname === '/api/v1/veo/record-info'
      || pathname === '/api/v1/playground/getAsset');

  if (isStatusPoll) {
    stats.statusPoll += 1;
    const taskId = url.searchParams.get('taskId') ?? url.searchParams.get('assetId');
    const task = taskId ? tasks.get(taskId) : null;
    if (!task) {
      return json(response, 200, { code: 200, msg: 'success', data: { taskId, successFlag: 0 } });
    }

    const completed = task.state === 'completed'
      || (options.completionDelaySeconds > 0
        && Date.now() - task.createdAt >= options.completionDelaySeconds * 1000);

    return json(response, 200, {
      code: 200,
      msg: 'success',
      data: {
        taskId,
        successFlag: completed ? 1 : 0,
        ...(completed ? { resultJson: buildResultJson(taskId, taskKind(task)) } : {}),
      },
    });
  }

  // Prompt enhancement and the workflow blueprint/assistant paths.
  if (request.method === 'POST' && pathname.endsWith('/v1/chat/completions')) {
    stats.chatCompletion += 1;
    return json(response, 200, {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'a cinematic product shot, studio lighting, 85mm' },
      }],
    });
  }

  return json(response, 404, { code: 404, msg: `unhandled stub route: ${pathname}` });
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    json(response, 500, { code: 500, msg: error.message });
  });
});

server.listen(options.port, () => {
  console.log(`Provider stub listening on :${options.port}`);
  console.log(`  completion delay ${options.completionDelaySeconds}s`
    + ` · 429 rate ${options.rateLimitRate} · 5xx rate ${options.serverErrorRate}`);
  console.log(`  media base ${mediaBaseUrl()}`);
});
