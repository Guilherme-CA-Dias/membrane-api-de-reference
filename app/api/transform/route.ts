import { NextRequest, NextResponse } from "next/server";
import { dereferenceWholeSpec, exportSelectedOperations, fetchOpenApiSpec } from "@/lib/openapi";

type TransformRequest =
  | {
      mode: "full";
    }
  | {
      mode: "operations";
      operationIds: string[];
    };

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as TransformRequest;
    const spec = await fetchOpenApiSpec();

    let output;
    let fileName;

    if (body.mode === "full") {
      output = dereferenceWholeSpec(spec);
      fileName = "membrane-openapi.dereferenced.json";
    } else if (body.mode === "operations" && Array.isArray(body.operationIds) && body.operationIds.length > 0) {
      output = exportSelectedOperations(spec, body.operationIds);
      const suffix = body.operationIds.length === 1 ? body.operationIds[0] : `${body.operationIds.length}-operations`;
      fileName = `membrane-openapi.${suffix}.json`;
    } else {
      return NextResponse.json({ error: "Select at least one operation." }, { status: 400 });
    }

    return NextResponse.json({
      fileName,
      generatedAt: new Date().toISOString(),
      json: JSON.stringify(output, null, 2),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Transformation failed." },
      { status: 500 },
    );
  }
}
