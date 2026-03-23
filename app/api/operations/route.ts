import { NextResponse } from "next/server";
import { fetchOpenApiSpec, listOperations } from "@/lib/openapi";

export async function GET() {
  try {
    const spec = await fetchOpenApiSpec();
    return NextResponse.json({
      operations: listOperations(spec),
      specTitle: spec.info?.title ?? "Membrane API",
      sourceUrl: "https://api.getmembrane.com/docs-json",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load OpenAPI spec." },
      { status: 500 },
    );
  }
}
