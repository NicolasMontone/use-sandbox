"use client";

import { useChat } from "@ai-sdk/react";
import { useState } from "react";

export default function Home() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");

  const isLoading = status === "streaming" || status === "submitted";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    const message = input;
    setInput("");
    await sendMessage({ text: message });
  };

  return (
    <main className="min-h-screen flex flex-col p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">AI Agent with Sandbox</h1>
      <p className="text-gray-400 mb-8">
        Demonstrating{" "}
        <code className="text-blue-400">&quot;use sandbox&quot;</code> directive
      </p>

      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="text-gray-500 text-center py-8">
            <p>Try asking the AI to:</p>
            <ul className="mt-2 space-y-1 text-sm">
              <li>• Create a file in /tmp with some content</li>
              <li>• Read a file from the sandbox</li>
              <li>• List files in a directory</li>
              <li>• Run a shell command like &quot;uname -a&quot;</li>
            </ul>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className="space-y-2">
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <div
                    key={i}
                    className={`p-4 rounded-lg ${
                      message.role === "user"
                        ? "bg-blue-900/30 ml-8"
                        : "bg-gray-800/50 mr-8"
                    }`}
                  >
                    <div className="text-xs text-gray-500 mb-1">
                      {message.role === "user" ? "You" : "AI Agent"}
                    </div>
                    <div className="whitespace-pre-wrap">{part.text}</div>
                  </div>
                );
              }

              // Handle tool parts (both static and dynamic)
              if (part.type.startsWith("tool-")) {
                const toolPart = part as {
                  type: string;
                  toolName?: string;
                  toolCallId: string;
                  state: string;
                  input?: unknown;
                  output?: unknown;
                };
                const toolName =
                  toolPart.toolName || part.type.replace("tool-", "");
                const isDone = toolPart.state === "output-available";

                return (
                  <div
                    key={i}
                    className="mx-4 my-2 border border-yellow-600/30 rounded-lg overflow-hidden"
                  >
                    <div
                      className={`px-3 py-2 text-sm font-mono flex items-center gap-2 ${
                        isDone ? "bg-green-900/30" : "bg-yellow-900/30"
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${
                          isDone
                            ? "bg-green-500"
                            : "bg-yellow-500 animate-pulse"
                        }`}
                      />
                      <span className="text-yellow-400">🔧 {toolName}</span>
                      <span className="text-gray-500 text-xs">
                        {isDone ? "done" : "running..."}
                      </span>
                    </div>
                    <div className="px-3 py-2 bg-gray-900/50 text-xs font-mono">
                      <div className="text-gray-400 mb-1">Args:</div>
                      <pre className="text-gray-300 overflow-x-auto">
                        {JSON.stringify(toolPart.input, null, 2)}
                      </pre>
                      {isDone && toolPart.output !== undefined && (
                        <>
                          <div className="text-gray-400 mt-2 mb-1">Result:</div>
                          <pre className="text-green-400 overflow-x-auto whitespace-pre-wrap">
                            {typeof toolPart.output === "string"
                              ? toolPart.output
                              : JSON.stringify(toolPart.output, null, 2)}
                          </pre>
                        </>
                      )}
                    </div>
                  </div>
                );
              }

              return null;
            })}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the AI to read or write files in the sandbox..."
          className="flex-1 px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading}
          className="px-6 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "Sending..." : "Send"}
        </button>
      </form>
    </main>
  );
}
