import { cache } from "react";

export const SPEC_URL = "https://api.getmembrane.com/docs-json";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type OpenApiDocument = {
  openapi?: string;
  info?: Record<string, JsonValue>;
  servers?: JsonValue[];
  security?: JsonValue[];
  tags?: Array<Record<string, JsonValue>>;
  externalDocs?: Record<string, JsonValue>;
  components?: Record<string, Record<string, JsonValue>>;
  paths?: Record<string, Record<string, JsonValue>>;
  [key: string]: JsonValue | undefined;
};

export type OperationSummary = {
  path: string;
  method: string;
  operationId: string;
  summary: string;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeIdentifier(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^0-9a-z]+/g, "");
}

function unescapeJsonPointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointer(document: OpenApiDocument, ref: string): JsonValue {
  if (!ref.startsWith("#/")) {
    throw new Error(`Only local refs are supported: ${ref}`);
  }

  let current: JsonValue = document as JsonValue;
  for (const rawToken of ref.slice(2).split("/")) {
    const token = unescapeJsonPointer(rawToken);
    current = (current as Record<string, JsonValue>)[token];
  }
  return current;
}

function collectComponentRefs(node: JsonValue, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectComponentRefs(item, found);
    }
    return found;
  }

  if (!node || typeof node !== "object") {
    return found;
  }

  const record = node as Record<string, JsonValue>;
  const ref = record.$ref;
  if (typeof ref === "string" && ref.startsWith("#/components/")) {
    found.add(ref);
  }

  for (const value of Object.values(record)) {
    collectComponentRefs(value, found);
  }

  return found;
}

function resolveRefNode(
  node: JsonValue,
  root: OpenApiDocument,
  seenRefs = new Set<string>(),
  onCycle: "truncate" | "preserve" = "truncate",
): JsonValue {
  if (Array.isArray(node)) {
    return node.map((item) => resolveRefNode(item, root, new Set(seenRefs), onCycle));
  }

  if (!node || typeof node !== "object") {
    return clone(node);
  }

  const record = node as Record<string, JsonValue>;
  const ref = record.$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith("#/components/")) {
      return clone(node);
    }

    if (seenRefs.has(ref)) {
      return onCycle === "truncate" ? {} : { $ref: ref };
    }

    const resolved = clone(resolvePointer(root, ref));
    const merged = resolveRefNode(resolved, root, new Set([...seenRefs, ref]), onCycle);
    const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "$ref"));

    if (merged && typeof merged === "object" && !Array.isArray(merged)) {
      return {
        ...(merged as Record<string, JsonValue>),
        ...clone(siblings),
      };
    }

    return merged;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveRefNode(value, root, new Set(seenRefs), onCycle)]),
  );
}

function schemaPaths(openapi: OpenApiDocument) {
  const paths = openapi.paths ?? {};
  const rows: Array<{ path: string; method: string; operationId: string; operation: Record<string, JsonValue> }> = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method] as Record<string, JsonValue> | undefined;
      if (!operation || typeof operation !== "object") {
        continue;
      }

      rows.push({
        path,
        method,
        operationId: String(operation.operationId ?? `${method}${path}`),
        operation,
      });
    }
  }

  return rows;
}

export function listOperations(openapi: OpenApiDocument): OperationSummary[] {
  return schemaPaths(openapi).map(({ path, method, operationId, operation }) => ({
    path,
    method: method.toUpperCase(),
    operationId,
    summary: String(operation.summary ?? ""),
  }));
}

function buildSelectedOperationsSpec(openapi: OpenApiDocument, operationIds: string[]): OpenApiDocument {
  const selectedNorms = new Set(operationIds.map((item) => normalizeIdentifier(item)));
  const selected = schemaPaths(openapi).filter(({ operationId }) => selectedNorms.has(normalizeIdentifier(operationId)));

  if (selected.length === 0) {
    throw new Error("No matching operationIds were found.");
  }

  const paths: Record<string, Record<string, JsonValue>> = {};

  for (const { path, method } of selected) {
    const originalPathItem = openapi.paths?.[path] ?? {};
    if (!paths[path]) {
      paths[path] = {};
    }

    const filteredPathItem: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(originalPathItem)) {
      if (key === method || key === "parameters" || key.startsWith("x-")) {
        filteredPathItem[key] = clone(value);
      }
    }

    const dereferencedPathItem = resolveRefNode(filteredPathItem, openapi, new Set(), "truncate");
    paths[path] = {
      ...paths[path],
      ...(dereferencedPathItem as Record<string, JsonValue>),
    };
  }

  const result: OpenApiDocument = {
    openapi: openapi.openapi ?? "3.0.0",
    paths,
  };

  for (const key of ["info", "servers", "security", "externalDocs"] as const) {
    const value = openapi[key];
    if (value !== undefined) {
      (result as Record<string, JsonValue | undefined>)[key] = clone(value);
    }
  }

  if (openapi.tags) {
    const selectedTags = new Set<string>();
    for (const pathItem of Object.values(paths)) {
      for (const method of HTTP_METHODS) {
        const op = pathItem[method] as Record<string, JsonValue> | undefined;
        const tags = op?.tags;
        if (Array.isArray(tags)) {
          for (const tag of tags) {
            if (typeof tag === "string") {
              selectedTags.add(tag);
            }
          }
        }
      }
    }
    result.tags = openapi.tags.filter((tag) => selectedTags.has(String(tag.name ?? "")));
  }

  for (const [key, value] of Object.entries(openapi)) {
    if (key in result || key === "paths" || key === "components" || key === "tags") {
      continue;
    }
    if (key.startsWith("x-")) {
      (result as Record<string, JsonValue | undefined>)[key] = clone(value);
    }
  }

  const remainingRefs = collectComponentRefs(result as JsonValue);
  if (remainingRefs.size > 0) {
    const sourceComponents = openapi.components ?? {};
    const builtComponents: Record<string, Record<string, JsonValue>> = {};
    const pending = [...remainingRefs];
    const seen = new Set<string>();

    while (pending.length > 0) {
      const ref = pending.pop()!;
      if (seen.has(ref)) {
        continue;
      }
      seen.add(ref);

      const parts = ref.split("/");
      if (parts.length !== 4 || parts[1] !== "components") {
        continue;
      }

      const [, , section, name] = parts;
      const sourceSection = sourceComponents[section];
      const sourceValue = sourceSection?.[name];
      if (!sourceValue) {
        continue;
      }

      const resolved = resolveRefNode(sourceValue, openapi, new Set([ref]), "truncate");
      if (!builtComponents[section]) {
        builtComponents[section] = {};
      }
      builtComponents[section][name] = resolved;

      for (const nestedRef of collectComponentRefs(resolved)) {
        if (!seen.has(nestedRef)) {
          pending.push(nestedRef);
        }
      }
    }

    if (Object.keys(builtComponents).length > 0) {
      result.components = builtComponents;
    }
  }

  return result;
}

export function dereferenceWholeSpec(openapi: OpenApiDocument): OpenApiDocument {
  return resolveRefNode(openapi as JsonValue, openapi, new Set(), "truncate") as OpenApiDocument;
}

export function exportSelectedOperations(openapi: OpenApiDocument, operationIds: string[]): OpenApiDocument {
  return buildSelectedOperationsSpec(openapi, operationIds);
}

export const fetchOpenApiSpec = cache(async (): Promise<OpenApiDocument> => {
  const response = await fetch(SPEC_URL, {
    headers: {
      Accept: "application/json",
    },
    next: {
      revalidate: 300,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
  }

  return (await response.json()) as OpenApiDocument;
});
