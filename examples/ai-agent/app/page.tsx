'use client';

import { useState } from 'react';

export default function Home() {
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage],
        }),
      });

      if (!response.ok) throw new Error('Failed to send message');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = '';

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        
        assistantMessage += decoder.decode(value, { stream: true });
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: assistantMessage },
        ]);
      }
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">AI Agent with Sandbox</h1>
      <p className="text-gray-400 mb-8">
        Demonstrating <code className="text-blue-400">"use sandbox"</code> and <code className="text-blue-400">"use exec"</code> directives
      </p>

      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="text-gray-500 text-center py-8">
            <p>Try asking the AI to:</p>
            <ul className="mt-2 space-y-1 text-sm">
              <li>• Create a file in /tmp with some content</li>
              <li>• Read a file from the sandbox</li>
              <li>• List files in a directory</li>
              <li>• Run a shell command</li>
            </ul>
          </div>
        )}
        {messages.map((message, i) => (
          <div
            key={i}
            className={`p-4 rounded-lg ${
              message.role === 'user'
                ? 'bg-blue-900/30 ml-8'
                : 'bg-gray-800/50 mr-8'
            }`}
          >
            <div className="text-xs text-gray-500 mb-1">
              {message.role === 'user' ? 'You' : 'AI Agent'}
            </div>
            <div className="whitespace-pre-wrap">{message.content}</div>
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
          {isLoading ? 'Sending...' : 'Send'}
        </button>
      </form>
    </main>
  );
}

