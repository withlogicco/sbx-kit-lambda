import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { StepConverter } = await jiti.import("../files/home/.pi/agent/extensions/claude-agent/stream.ts");

function step() {
  const events = [];
  const output = {
    role: "assistant",
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason: "pending",
  };
  const converter = new StepConverter({ push: (event) => events.push(event), end() {} }, output, new Set());
  return {
    events,
    output,
    converter,
    send: (event) => converter.handle({ type: "stream_event", parent_tool_use_id: null, event }),
  };
}

const success = { type: "result", subtype: "success", stop_reason: "end_turn" };

function usage(reply, id, input, output, cacheRead = 0) {
  reply.send({
    type: "message_start",
    message: { id, model: "opus", usage: { input_tokens: input, cache_read_input_tokens: cacheRead } },
  });
  reply.send({ type: "message_delta", usage: { output_tokens: output } });
}

test("streamed thinking emits balanced thinking events with its summary", () => {
  const reply = step();
  reply.send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  reply.send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "A summary" } });
  reply.send({ type: "content_block_stop", index: 0 });
  assert.deepEqual(
    reply.events.map((event) => event.type),
    ["thinking_start", "thinking_delta", "thinking_end"],
  );
  assert.equal(reply.events.at(-1).content, "A summary");
  assert.equal(reply.events.at(-1).contentIndex, 0);
});

test("streamed text still ends with text_end", () => {
  const reply = step();
  reply.send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "Hello" } });
  reply.send({ type: "content_block_stop", index: 0 });
  assert.deepEqual(
    reply.events.map((event) => event.type),
    ["text_start", "text_delta", "text_end"],
  );
  assert.equal(reply.events.at(-1).content, "Hello");
});

test("whole-turn result totals do not count earlier tool steps again", () => {
  const tools = step();
  usage(tools, "tool-phase", 100, 10, 50);
  tools.converter.finishTools();

  const answer = step();
  usage(answer, "answer-phase", 200, 20, 75);
  answer.converter.handle({
    ...success,
    usage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 125 },
  });
  answer.converter.finishResult(success, false, false);

  assert.equal(tools.output.usage.output + answer.output.usage.output, 30);
  assert.equal(answer.output.usage.input, 200);
  assert.equal(answer.output.usage.cacheRead, 75);
  assert.equal(answer.output.usage.totalTokens, 295);
  assert.equal(answer.output.usage.cost.total, 0);
});

test("per-message usage counts echoes once and keeps the last prompt occupancy", () => {
  const reply = step();
  usage(reply, "first", 100, 10);
  reply.converter.handle({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "first", content: [], usage: { input_tokens: 100, output_tokens: 10 } },
  });
  usage(reply, "second", 200, 20, 75);
  reply.converter.handle({ ...success, usage: { input_tokens: 300, output_tokens: 30 } });
  reply.converter.finishResult(success, false, false);

  assert.equal(reply.output.usage.input, 200);
  assert.equal(reply.output.usage.cacheRead, 75);
  assert.equal(reply.output.usage.output, 30);
  assert.equal(reply.output.usage.totalTokens, 305);
});
