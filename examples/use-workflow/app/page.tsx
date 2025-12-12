"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [sandboxKey, setSandboxKey] = useState<string | null>(null);

  useEffect(() => {
    setSandboxKey(`test-${Date.now()}`);
  }, []);

  const triggerWorkflow = async () => {
    setLoading(true);
    setStatus("Starting workflow...");
    setResult(null);

    try {
      const res = await fetch(`/api/trigger?key=${sandboxKey || Date.now()}`, {
        method: "POST",
      });
      const data = await res.json();
      setStatus("Workflow started!");
      setResult(data);
    } catch (error) {
      setStatus(`Error: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">Workflow + Sandbox Example</h1>
      <p className="text-gray-400 mb-4">
        Combining{" "}
        <code className="text-emerald-400">&quot;use workflow&quot;</code> with{" "}
        <code className="text-blue-400">&quot;use sandbox&quot;</code>
      </p>

      <div className="mb-8 p-4 bg-gray-800/50 rounded-lg text-sm font-mono">
        <p className="text-gray-300 mb-2">Pattern:</p>
        <ul className="space-y-1 text-gray-400">
          <li>
            <span className="text-emerald-400">workflow</span> → orchestrates
            durable execution
          </li>
          <li>
            <span className="text-purple-400">step</span> → performs side
            effects with Node.js access
          </li>
          <li>
            <span className="text-blue-400">sandbox</span> → runs code in
            isolated environment
          </li>
        </ul>
      </div>

      <button
        onClick={triggerWorkflow}
        disabled={loading}
        className="px-6 py-3 bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {loading ? "Running..." : "Trigger Workflow"}
      </button>

      {status && (
        <div className="mt-6 p-4 bg-gray-800 rounded-lg">
          <p className="text-gray-300">{status}</p>
          {!!result && (
            <pre className="mt-2 text-sm text-gray-400 overflow-x-auto">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}

      <div className="mt-8 p-4 border border-gray-700 rounded-lg">
        <h2 className="text-lg font-semibold mb-3">How it works</h2>
        <div className="text-sm text-gray-400 space-y-4 font-mono">
          <div>
            <p className="text-emerald-400 mb-1">
              sandboxFileWorkflow(sandboxKey)
            </p>
            <p className="ml-4">&quot;use workflow&quot;</p>
            <p className="ml-4">↓ calls step functions durably</p>
          </div>
          <div>
            <p className="text-purple-400 mb-1">
              writeFile(&#123; sandboxKey, path, content &#125;)
            </p>
            <p className="ml-4">&quot;use step&quot;</p>
            <p className="ml-4">
              ↓ calls sandbox.run(sandboxKey, sandboxWriteFile, [...])
            </p>
          </div>
          <div>
            <p className="text-blue-400 mb-1">
              sandboxWriteFile(path, content)
            </p>
            <p className="ml-4">&quot;use sandbox&quot;</p>
            <p className="ml-4">↓ runs fs.writeFile in isolated sandbox</p>
          </div>
        </div>
      </div>
    </main>
  );
}
