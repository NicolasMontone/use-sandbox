import { start } from "workflow/api";
import { sandboxFileWorkflow } from "../../workflows/sandbox-workflow";

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const sandboxKey = searchParams.get("key") || `workflow-${Date.now()}`;

  console.log("[api/trigger] Starting workflow with sandboxKey:", sandboxKey);

  try {
    // Execute the workflow (in production this would be durable via workflow runtime)
    const result = await start(sandboxFileWorkflow, [sandboxKey]);

    return Response.json({
      success: true,
      sandboxKey,
      result,
    });
  } catch (error) {
    console.error("[api/trigger] Workflow error:", error);
    return Response.json(
      {
        success: false,
        sandboxKey,
        error: String(error),
      },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  // Convenience: allow GET for easy testing
  return POST(req);
}
