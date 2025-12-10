/**
 * Simple test endpoint to verify sandbox directives are working.
 * No AI Gateway required - just tests the sandbox execution.
 */

async function testExec(): Promise<string> {
  "use exec";
  // This code runs inside the Vercel Sandbox
  const os = await import("os");
  return `Running in sandbox! Platform: ${os.platform()}, Hostname: ${os.hostname()}`;
}

export async function GET() {
  "use sandbox";

  try {
    const result = await testExec();
    return Response.json({
      success: true,
      message: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
