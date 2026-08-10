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
  else if (argument === '--forward-target') { options.forwardTarget = value; index += 1; }
  else if (argument === '--forward-bypass') { options.forwardBypass = value; index += 1; }
}
options.forwardTarget = options.forwardTarget ?? null;
options.forwardBypass = options.forwardBypass ?? null;

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
  /**
   * Requests the branch's `kie-webhook` forwarded HERE. Normally zero: the
   * function forwards to whatever origin its `NEXT_PUBLIC_SITE_URL` secret
   * names, which for a real run is the preview. Pointing that secret at this
   * tunnel for one request is how the forward target gets *proved* rather than
   * assumed — the alternative is discovering it by watching production receive
   * a callback. It stays instrumented afterwards so a stray forward is visible.
   */
  webhookForwards: 0,
  forwardFailures: 0,
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

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readBody(request) {
  const raw = await readRawBody(request);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
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
function resultUrlFor(taskId, kind) {
  return `${mediaBaseUrl()}/media/${taskId}.${kind === 'video' ? 'mp4' : 'jpg'}`;
}

function buildResultJson(taskId, kind) {
  return JSON.stringify({ resultUrls: [resultUrlFor(taskId, kind)] });
}

/**
 * The two status-poll paths disagree about the shape, and the stub has to
 * satisfy both because the model decides which one is used.
 *
 * - `/api/v1/jobs/recordInfo` (images, most models) reads `data.state`, which
 *   must be the string 'success' or 'fail', and takes its URL from
 *   `data.resultJson` — a JSON *string*.
 * - `/api/v1/veo/record-info` (veo video) reads `data.successFlag` (1 success,
 *   2/3 failure) and takes its URL from `data.response.resultUrls` — a nested
 *   object, not resultJson.
 *
 * Emitting only `successFlag` + `resultJson`, as this stub originally did, fails
 * both: the jobs path never leaves 'processing' (measured — 12 completions
 * enqueued and retried with "Generation is still processing."), and the veo path
 * settles succeeded with no output URL, which is worse because it looks fine.
 */
function buildTaskStatusData(taskId, kind, completed, failed = false) {
  if (!completed) {
    return { taskId, state: 'generating', successFlag: 0 };
  }
  if (failed) {
    return { taskId, state: 'fail', successFlag: 2, errorMessage: 'stubbed provider failure' };
  }
  return {
    taskId,
    state: 'success',
    successFlag: 1,
    resultJson: buildResultJson(taskId, kind),
    response: { resultUrls: [resultUrlFor(taskId, kind)] },
  };
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
    data: buildTaskStatusData(taskId, taskKind(task), true),
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

/**
 * A genuinely decodable 64x64 H.264/MP4, not a renamed JPEG. The video import
 * path probes and transcodes what it fetches, so serving image bytes under an
 * .mp4 name would fail every video ingest and score the media pipeline as
 * broken when the fault was the fixture. 1,787 bytes, one second, eight frames.
 */
const VIDEO_BYTES = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAORbW9vdgAAAGxtdmhkAAAAAAAAAAAA'
  + 'AAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA'
  + 'AABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAArx0cmFrAAAAXHRraGQAAAADAAAA'
  + 'AAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA'
  + 'AAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAQAAABAAAA'
  + 'AAI0bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZp'
  + 'ZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB321pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAA'
  + 'ACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAZ9zdGJsAAAAv3N0c2QAAAAAAAAA'
  + 'AQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFExhdmM2'
  + 'MC4zLjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQA'
  + 'AAMABAAAAwBAPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAZ'
  + '0AAAGdAAAAAYc3R0cwAAAAAAAAABAAAACAAACAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAAEhjdHRz'
  + 'AAAAAAAAAAcAAAABAAAQAAAAAAEAACgAAAAAAQAAEAAAAAABAAAAAAAAAAEAAAgAAAAAAQAAIAAA'
  + 'AAACAAAIAAAAABxzdHNjAAAAAAAAAAEAAAABAAAACAAAAAEAAAA0c3RzegAAAAAAAAAAAAAACAAA'
  + 'AtoAAAAOAAAADAAAAAwAAAAMAAAAFAAAAA4AAAAMAAAAFHN0Y28AAAAAAAAAAQAAA8EAAABhdWR0'
  + 'YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAA'
  + 'JKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYwLjMuMTAwAAAACGZyZWUAAANCbWRhdAAAAq0GBf//'
  + 'qdxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMwNzUgNjZhNWJjMSAtIEguMjY0L01Q'
  + 'RUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjEgLSBodHRwOi8vd3d3LnZpZGVvbGFu'
  + 'Lm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5h'
  + 'bHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhl'
  + 'ZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAg'
  + 'ZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0y'
  + 'IGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50'
  + 'ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBi'
  + 'X3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29w'
  + 'PTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj04IHNjZW5lY3V0PTQwIGludHJhX3Jl'
  + 'ZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAu'
  + 'NjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAA'
  + 'JWWIhAAR//7n4/wKbYEB8OZd9zkjqEejXHtijNqS8fduEPbEZ/EAAAAKQZokbEEP/qpX3gAAAAhB'
  + 'nkJ4h/8ExQAAAAgBnmF0Q78FvAAAAAgBnmNqQ78FvQAAABBBmmdJqEFomUwId//+qZ01AAAACkGe'
  + 'hUURLDv/Bb0AAAAIAZ6makO/Bb0=',
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

  /**
   * Runtime knobs, because the webhook-burst case needs a *backlog* of pending
   * tasks and the soak needs tasks that complete on their own. Restarting the
   * stub between the two would discard every task it is holding, which is
   * exactly the state the burst is supposed to fire.
   */
  if (pathname === '/stub/config' && request.method === 'POST') {
    const body = await readBody(request);
    if (body.completionDelaySeconds !== undefined) {
      options.completionDelaySeconds = Number(body.completionDelaySeconds);
    }
    if (body.rateLimitRate !== undefined) options.rateLimitRate = Number(body.rateLimitRate);
    if (body.serverErrorRate !== undefined) options.serverErrorRate = Number(body.serverErrorRate);
    return json(response, 200, {
      completionDelaySeconds: options.completionDelaySeconds,
      rateLimitRate: options.rateLimitRate,
      serverErrorRate: options.serverErrorRate,
    });
  }

  if (pathname === '/stub/reset' && request.method === 'POST') {
    tasks.clear();
    for (const key of Object.keys(stats)) stats[key] = 0;
    return json(response, 200, { ok: true });
  }

  /**
   * Relay for the edge function's signed forward.
   *
   * Vercel Deployment Protection guards every preview except custom domains,
   * and `kie-webhook` cannot add the `x-vercel-protection-bypass` header — it
   * forwards to whatever origin its NEXT_PUBLIC_SITE_URL secret names, with
   * headers it builds itself. Pointing that secret here and relaying with the
   * bypass keeps the real edge function, the real HMAC signature and the real
   * app endpoint in the path; only the network hop is different.
   *
   * The body is relayed as raw bytes and the signing headers are copied
   * verbatim. The signature covers the exact request body, so re-encoding or
   * re-serialising it here would fail verification at the app — correctly, and
   * confusingly.
   */
  if (pathname === '/api/webhooks/kie') {
    stats.webhookForwards += 1;
    const raw = await readRawBody(request);

    if (!options.forwardTarget) {
      console.log('[forward] received but no --forward-target configured');
      return json(response, 200, { ok: true, probe: true });
    }

    const target = new URL(`/api/webhooks/kie${url.search}`, options.forwardTarget);
    // `request` is a Node IncomingMessage, so headers are a plain lowercase-keyed
    // object — not a Fetch `Headers` with `.get()`.
    const headers = { 'Content-Type': request.headers['content-type'] || 'application/json' };
    for (const name of ['x-webhook-timestamp', 'x-webhook-payload-signature']) {
      const value = request.headers[name];
      if (value) headers[name] = value;
    }
    if (options.forwardBypass) headers['x-vercel-protection-bypass'] = options.forwardBypass;

    try {
      const upstream = await fetch(target, { method: 'POST', headers, body: raw });
      const text = await upstream.text();
      if (!upstream.ok) {
        stats.forwardFailures += 1;
        console.log(`[forward] ${upstream.status} ${text.slice(0, 160)}`);
      }
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      return response.end(text);
    } catch (error) {
      stats.forwardFailures += 1;
      console.log(`[forward] relay failed: ${error.message}`);
      return json(response, 502, { error: 'relay failed' });
    }
  }

  // --- media, for realistic ingest ---------------------------------------
  if (pathname.startsWith('/media/')) {
    stats.mediaServed += 1;
    const isVideo = pathname.endsWith('.mp4');
    const bytes = isVideo ? VIDEO_BYTES : IMAGE_BYTES;
    response.writeHead(200, {
      'Content-Type': isVideo ? 'video/mp4' : 'image/jpeg',
      'Content-Length': bytes.length,
    });
    return response.end(bytes);
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
      return json(response, 200, {
        code: 200,
        msg: 'success',
        data: buildTaskStatusData(taskId, 'image', false),
      });
    }

    const completed = task.state === 'completed'
      || (options.completionDelaySeconds > 0
        && Date.now() - task.createdAt >= options.completionDelaySeconds * 1000);

    return json(response, 200, {
      code: 200,
      msg: 'success',
      data: buildTaskStatusData(taskId, taskKind(task), completed),
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
