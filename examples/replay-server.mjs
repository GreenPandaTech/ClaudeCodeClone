// A tiny local stand-in for the Anthropic Messages streaming API, used by
// capture-transcript.mjs so the REAL built binary (dist/index.js) can run a
// scripted conversation with no API key and nothing leaving the machine. The
// SDK honours ANTHROPIC_BASE_URL, so TerminalAgent itself is completely unmodified —
// same SDK, same SSE parser, same agentic loop, same tools, same checkpoints.
//
// The script is fixed: turn 1 answers the user's prompt with an edit_file tool
// call on greet.js; turn 2 (after the tool result comes back) closes the turn.

import http from "http";

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Stream one scripted assistant message as Messages-API SSE events. */
function streamMessage(res, { text, toolUse, stopReason }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_replay",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  );
  let index = 0;
  if (text) {
    res.write(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
    res.write(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }));
    res.write(sse("content_block_stop", { type: "content_block_stop", index }));
    index++;
  }
  if (toolUse) {
    res.write(
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: toolUse.id, name: toolUse.name, input: {} },
      }),
    );
    res.write(
      sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input) },
      }),
    );
    res.write(sse("content_block_stop", { type: "content_block_stop", index }));
  }
  res.write(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
  );
  res.write(sse("message_stop", { type: "message_stop" }));
  res.end();
}

/** Start the replay server; resolves with { port, close }. */
export function startReplayServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const messages = JSON.parse(body).messages ?? [];
      const last = messages[messages.length - 1];
      const isToolResult =
        Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");

      if (isToolResult) {
        streamMessage(res, {
          text: "Done - greet() now greets from TerminalAgent.",
          stopReason: "end_turn",
        });
      } else {
        streamMessage(res, {
          text: "I'll update the greeting in greet.js.",
          toolUse: {
            id: "toolu_replay_1",
            name: "edit_file",
            input: {
              file_path: "greet.js",
              old_string: "  return `Hello, ${name}!`;",
              new_string: "  return `Hello from TerminalAgent, ${name}!`;",
            },
          },
          stopReason: "tool_use",
        });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}
