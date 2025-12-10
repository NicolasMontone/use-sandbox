import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Agent with Sandbox',
  description: 'AI agent with file system access via Vercel Sandbox',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

