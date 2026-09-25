import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestAPI, type ModelRequest } from '../electron/core/ai-provider';
import type { AIConnection, ApiFormat } from '../src/shared/ai';

const request: ModelRequest = {
  system: 'Preserve resume facts.',
  prompt: 'Make the heading larger.',
  images: ['data:image/png;base64,AA=='],
  schema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
};
const profile = (format: ApiFormat): AIConnection => ({
  id: 'fixture',
  name: 'Test API',
  kind: 'custom',
  model: 'vision-fixture',
  baseUrl: 'https://fixture.invalid/v1',
  format,
  hasKey: true,
  vision: 'unknown',
});
const answer = { message: 'Updated heading.' };
const responses = {
  responses: {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }],
  },
  anthropic: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] },
  'chat-completions': {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
  },
};

test('API adapters send source, images, credentials and schema using each supported wire format', async (t) => {
  for (const format of ['responses', 'anthropic', 'chat-completions'] as const)
    await t.test(format, async (t) => {
      let captured: { url: string; options: RequestInit } | undefined;
      t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
        captured = { url, options };
        return Response.json(responses[format]);
      });
      assert.deepEqual(
        await requestAPI(
          { profile: profile(format), apiKey: 'fixture-secret' },
          request,
          new AbortController().signal,
        ),
        answer,
      );
      assert.ok(captured);
      const { url, options } = captured;
      const body = JSON.parse(options.body as string);
      const headers = new Headers(options.headers);
      assert.equal(options.redirect, 'error');
      assert.equal(body.model, 'vision-fixture');
      assert.equal(
        headers.get(format === 'anthropic' ? 'x-api-key' : 'Authorization'),
        format === 'anthropic' ? 'fixture-secret' : 'Bearer fixture-secret',
      );
      assert.ok(!String(options.body).includes('fixture-secret'));
      if (format === 'responses') {
        assert.equal(url, 'https://fixture.invalid/v1/responses');
        assert.equal(body.store, false);
        assert.deepEqual(body.text.format.schema, request.schema);
        assert.equal(body.input[0].content[1].image_url, request.images[0]);
        assert.equal(body.input[0].content[0].text, request.prompt);
      } else if (format === 'anthropic') {
        assert.equal(url, 'https://fixture.invalid/v1/messages');
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        assert.equal(body.messages[0].content[1].source.data, 'AA==');
        assert.equal(body.messages[0].content[0].text, request.prompt);
      } else {
        assert.equal(url, 'https://fixture.invalid/v1/chat/completions');
        assert.equal(body.messages[1].content[1].image_url.url, request.images[0]);
        assert.equal(body.messages[1].content[0].text, request.prompt);
      }
    });
});

test('API errors are actionable and do not expose response bodies or credentials', async (t) => {
  for (const [status, expected] of [
    [401, /key or access/],
    [429, /usage limit/],
    [500, /HTTP 500/],
  ] as const)
    await t.test(String(status), async (t) => {
      t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('sensitive-server-detail', { status }),
      );
      await assert.rejects(
        requestAPI({ profile: profile('responses') }, request, new AbortController().signal),
        (error) => {
          assert.match((error as Error).message, expected);
          assert.ok(!(error as Error).message.includes('sensitive-server-detail'));
          return true;
        },
      );
    });
  await t.test('truncated output', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ status: 'incomplete', output_text: JSON.stringify(answer) }),
    );
    await assert.rejects(
      requestAPI({ profile: profile('responses') }, request, new AbortController().signal),
      /not completed/,
    );
  });
  await t.test('cancelled transport', async (t) => {
    const controller = new AbortController();
    controller.abort();
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('transport');
    });
    await assert.rejects(
      requestAPI({ profile: profile('responses') }, request, controller.signal),
      { name: 'AbortError' },
    );
  });
  await t.test('malformed JSON', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ status: 'completed', output_text: 'not-json' }),
    );
    await assert.rejects(
      requestAPI({ profile: profile('responses') }, request, new AbortController().signal),
      /valid JSON/,
    );
  });
});
