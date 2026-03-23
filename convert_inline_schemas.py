#!/usr/bin/env python3
"""Utilities for reshaping OpenAPI specs.

Supported workflows:
  1. Convert inline request/response schemas into component refs.
  2. Replace every usage of a component ref with its inline schema.
  3. Generate a standalone OpenAPI spec for a single operationId.

Examples:
  python convert_inline_schemas.py -i openapi.json --convert-inline
  python convert_inline_schemas.py -i openapi.json --dereference-ref CreateAction
  python convert_inline_schemas.py -i openapi.json --operation-id createAction -o createAction.json
  python convert_inline_schemas.py -i openapi.json --operation-id
"""

import argparse
import copy
import json
import os
import re
from collections import OrderedDict


HTTP_METHODS = ("get", "post", "put", "patch", "delete", "options", "head")


def normalize_obj(value):
    if isinstance(value, dict):
        return {key: normalize_obj(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [normalize_obj(item) for item in value]
    return value


def signature(schema):
    return json.dumps(normalize_obj(schema), sort_keys=True, separators=(",", ":"))


def normalize_identifier(value):
    if value is None:
        return ""
    return re.sub(r"[^0-9a-z]+", "", str(value).lower())


def pick_default_type_name(parent_name, fallback_prefix):
    if not parent_name:
        return f"{fallback_prefix}Auto"
    cleaned = re.sub(r"[^0-9a-zA-Z_]+", "_", parent_name).strip("_")
    if not cleaned:
        cleaned = "Unnamed"
    parts = re.split(r"[_ -]+", cleaned)
    pascal = "".join(part.capitalize() for part in parts if part)
    if pascal and pascal[0].isdigit():
        pascal = "O" + pascal
    return pascal


def unescape_json_pointer(token):
    return token.replace("~1", "/").replace("~0", "~")


def resolve_pointer(document, ref):
    if not ref.startswith("#/"):
        raise ValueError(f"Only local refs are supported, got: {ref}")
    current = document
    for raw_token in ref[2:].split("/"):
        token = unescape_json_pointer(raw_token)
        current = current[token]
    return current


def schema_paths(openapi):
    for path, path_item in (openapi.get("paths") or {}).items():
        for method in HTTP_METHODS:
            op_obj = path_item.get(method)
            if not isinstance(op_obj, dict):
                continue
            operation_id = op_obj.get("operationId") or f"{method}{path}".replace("/", "_")
            yield path, method, operation_id, op_obj


def collect_inline_schemas(openapi):
    found = []
    for path, method, operation_id, op_obj in schema_paths(openapi):
        if "requestBody" in op_obj:
            request_body = op_obj["requestBody"]
            for media_type, mt_obj in (request_body.get("content") or {}).items():
                schema = mt_obj.get("schema")
                if isinstance(schema, dict) and "$ref" not in schema:
                    found.append((path, method, operation_id, "requestBody", media_type, schema))

        for status_code, response in (op_obj.get("responses") or {}).items():
            if not isinstance(response, dict):
                continue
            for media_type, mt_obj in (response.get("content") or {}).items():
                schema = mt_obj.get("schema")
                if isinstance(schema, dict) and "$ref" not in schema:
                    found.append((path, method, operation_id, f"responses/{status_code}", media_type, schema))
    return found


def collect_operation_matches(openapi, target_name):
    target_norm = normalize_identifier(target_name)
    matches = []
    for path, method, operation_id, _ in schema_paths(openapi):
        if normalize_identifier(operation_id) == target_norm:
            matches.append((path, method, operation_id))
    return matches


def list_operations(openapi):
    operations = []
    for path, method, operation_id, op_obj in schema_paths(openapi):
        operations.append({
            "path": path,
            "method": method,
            "operationId": operation_id,
            "summary": op_obj.get("summary", ""),
        })
    return operations


def choose_operation_interactively(openapi):
    operations = list_operations(openapi)
    if not operations:
        raise SystemExit("No operations were found in the OpenAPI document.")

    print("Available operationIds:")
    for index, operation in enumerate(operations, start=1):
        summary_suffix = f" - {operation['summary']}" if operation["summary"] else ""
        print(f"[{index}] {operation['operationId']} :: {operation['method'].upper()} {operation['path']}{summary_suffix}")

    choice = input("Enter the number of the operation you want to extract: ").strip()
    if not choice:
        raise SystemExit("No operation selected.")

    try:
        selected = operations[int(choice) - 1]
    except (ValueError, IndexError):
        raise SystemExit("Invalid operation selection.")

    print(f"Selected operationId: {selected['operationId']}")
    return selected["operationId"]


def write_output(document, output_path, dry_run):
    if dry_run:
        print("Dry run active: no output file written.")
        return
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
    print(f"Wrote updated OpenAPI to {output_path}")


def resolve_ref_node(node, root, seen_refs=None, on_cycle="preserve"):
    if seen_refs is None:
        seen_refs = set()

    if isinstance(node, list):
        return [resolve_ref_node(item, root, seen_refs.copy(), on_cycle=on_cycle) for item in node]

    if not isinstance(node, dict):
        return copy.deepcopy(node)

    if "$ref" in node and isinstance(node["$ref"], str):
        ref = node["$ref"]
        if not ref.startswith("#/components/"):
            return copy.deepcopy(node)
        if ref in seen_refs:
            if on_cycle == "truncate":
                return {}
            return {"$ref": ref}
        resolved = copy.deepcopy(resolve_pointer(root, ref))
        merged = resolve_ref_node(resolved, root, seen_refs | {ref}, on_cycle=on_cycle)
        sibling_keys = {key: copy.deepcopy(value) for key, value in node.items() if key != "$ref"}
        if sibling_keys and isinstance(merged, dict):
            merged.update(sibling_keys)
        return merged

    return {key: resolve_ref_node(value, root, seen_refs.copy(), on_cycle=on_cycle) for key, value in node.items()}


def replace_ref_instances(node, ref_to_replace, root, stats):
    if isinstance(node, list):
        return [replace_ref_instances(item, ref_to_replace, root, stats) for item in node]

    if not isinstance(node, dict):
        return node

    if node.get("$ref") == ref_to_replace:
        stats["replacements"] += 1
        replacement = resolve_ref_node(node, root)
        stats["locations"].append(stats["current_path"])
        return replacement

    updated = {}
    for key, value in node.items():
        prior_path = stats["current_path"]
        stats["current_path"] = f"{prior_path}/{key}"
        updated[key] = replace_ref_instances(value, ref_to_replace, root, stats)
        stats["current_path"] = prior_path
    return updated


def collect_component_refs(node, found=None):
    if found is None:
        found = set()

    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/"):
            found.add(ref)
        for value in node.values():
            collect_component_refs(value, found)
    elif isinstance(node, list):
        for item in node:
            collect_component_refs(item, found)

    return found


def build_operation_spec(openapi, target_operation_id):
    target_norm = normalize_identifier(target_operation_id)
    selected = None
    for path, method, operation_id, op_obj in schema_paths(openapi):
        if normalize_identifier(operation_id) == target_norm:
            selected = (path, method, operation_id, op_obj)
            break

    if not selected:
        raise SystemExit(f"No operationId matched '{target_operation_id}'.")

    path, method, operation_id, op_obj = selected
    path_item = openapi["paths"][path]

    new_spec = OrderedDict()
    new_spec["openapi"] = openapi.get("openapi", "3.0.0")

    if "info" in openapi:
        new_spec["info"] = copy.deepcopy(openapi["info"])
    if "servers" in openapi:
        new_spec["servers"] = copy.deepcopy(openapi["servers"])

    filtered_path_item = {}
    for key, value in path_item.items():
        if key == method:
            filtered_path_item[key] = copy.deepcopy(value)
        elif key == "parameters":
            filtered_path_item[key] = copy.deepcopy(value)
        elif key.startswith("x-"):
            filtered_path_item[key] = copy.deepcopy(value)

    dereferenced_path_item = resolve_ref_node(filtered_path_item, openapi, on_cycle="truncate")
    new_spec["paths"] = {path: dereferenced_path_item}

    refs_to_copy = set()
    refs_to_copy |= collect_component_refs(dereferenced_path_item)

    components_src = openapi.get("components") or {}
    components_out = OrderedDict()
    pending = list(refs_to_copy)
    seen = set()

    while pending:
        ref = pending.pop()
        if ref in seen:
            continue
        seen.add(ref)

        parts = ref.split("/")
        if len(parts) != 4 or parts[1] != "components":
            continue

        _, _, section, name = parts
        source_section = components_src.get(section)
        if not isinstance(source_section, dict) or name not in source_section:
            continue

        resolved_component = resolve_ref_node(source_section[name], openapi, {ref}, on_cycle="truncate")
        components_out.setdefault(section, OrderedDict())
        components_out[section][name] = resolved_component
        nested_refs = collect_component_refs(resolved_component)
        pending.extend(nested_refs - seen)

    if components_out:
        new_spec["components"] = components_out

    if "security" in openapi:
        new_spec["security"] = copy.deepcopy(openapi["security"])
    if "tags" in openapi:
        selected_tags = set(op_obj.get("tags") or [])
        if selected_tags:
            new_spec["tags"] = [copy.deepcopy(tag) for tag in openapi["tags"] if tag.get("name") in selected_tags]
    if "externalDocs" in openapi:
        new_spec["externalDocs"] = copy.deepcopy(openapi["externalDocs"])

    for key, value in openapi.items():
        if key in new_spec or key in {"paths", "components", "tags"}:
            continue
        if key.startswith("x-"):
            new_spec[key] = copy.deepcopy(value)

    return new_spec, path, method, operation_id, len(seen), len(refs_to_copy)


def convert_inline_mode(openapi, args):
    components = openapi.setdefault("components", {})
    schemas = components.setdefault("schemas", {})

    inline_list = collect_inline_schemas(openapi)
    if not inline_list:
        print("No inline schemas found to convert.")
        return openapi

    print(f"Found {len(inline_list)} inline schemas to potentially convert.")
    for index, (path, method, operation_id, location, media_type, schema) in enumerate(inline_list[:5], start=1):
        keys = list(schema.keys()) if isinstance(schema, dict) else "not dict"
        print(f"  [{index}] {path} [{method}] {location} {media_type} - schema keys: {keys}")

    candidates = []
    for path, method, operation_id, location, media_type, schema in inline_list:
        candidates.append({
            "path": path,
            "method": method,
            "operationId": operation_id,
            "location": location,
            "mediaType": media_type,
            "schema": schema,
            "suggestedType": pick_default_type_name(f"{operation_id}_{location}_{media_type}", "Auto"),
            "sig": signature(schema),
        })

    if args.type:
        target_norm = normalize_identifier(args.type)
        matched_schema_name = next((name for name in schemas if normalize_identifier(name) == target_norm), None)

        signature_matches = []
        if matched_schema_name:
            target_sig = signature(schemas[matched_schema_name])
            signature_matches = [candidate for candidate in candidates if candidate["sig"] == target_sig]

        operation_matches = [
            candidate for candidate in candidates
            if target_norm in normalize_identifier(candidate["operationId"])
            or target_norm in normalize_identifier(candidate["suggestedType"])
        ]

        if signature_matches:
            candidates = signature_matches
            type_map = {target_sig: matched_schema_name}
            limited_sigs = {target_sig}
        elif operation_matches:
            candidates = operation_matches
            sig_groups = OrderedDict()
            for candidate in candidates:
                sig_groups.setdefault(candidate["sig"], []).append(candidate)

            type_map = {}
            for index, (sig, entries) in enumerate(sig_groups.items(), start=1):
                base_name = matched_schema_name if matched_schema_name and index == 1 else entries[0]["suggestedType"]
                unique_name = base_name
                suffix = 1
                while unique_name in schemas and signature(schemas[unique_name]) != sig:
                    suffix += 1
                    unique_name = f"{base_name}{suffix}"
                type_map[sig] = unique_name
            limited_sigs = set(sig_groups.keys())
        else:
            op_hits = collect_operation_matches(openapi, args.type)
            if op_hits:
                print(f"No inline schemas found for '{args.type}'. Matching operationIds exist, but their request/response schemas already use $ref:")
                for path, method, operation_id in op_hits:
                    print(f"  - {path} [{method}] operationId={operation_id}")
            elif matched_schema_name:
                print(f"No inline schemas found that match the signature of '{matched_schema_name}'.")
            else:
                print(f"No inline schemas or operationIds matched '{args.type}'.")
            return openapi

        inline_list = [
            (candidate["path"], candidate["method"], candidate["operationId"], candidate["location"], candidate["mediaType"], candidate["schema"])
            for candidate in candidates
        ]
    else:
        sig_map = OrderedDict()
        for candidate in candidates:
            sig_map.setdefault(candidate["sig"], []).append(candidate)

        type_map = {}
        for sig, entries in sig_map.items():
            base_name = entries[0]["suggestedType"]
            unique_name = base_name
            suffix = 1
            while unique_name in schemas and signature(schemas[unique_name]) != sig:
                suffix += 1
                unique_name = f"{base_name}{suffix}"
            type_map[sig] = unique_name

        if args.interactive:
            print("Found deduplicated candidate types:")
            ordered_sigs = list(sig_map.keys())
            for index, sig in enumerate(ordered_sigs, start=1):
                print(f"[{index}] {type_map[sig]} (used by {len(sig_map[sig])} locations)")
            choice = input("Enter the number of the type you want to apply (or press Enter for all): ").strip()
            if choice:
                try:
                    selected_sig = ordered_sigs[int(choice) - 1]
                except (ValueError, IndexError):
                    raise SystemExit("Invalid selection")
                limited_sigs = {selected_sig}
                print(f"Selected type: {type_map[selected_sig]}")
            else:
                limited_sigs = set(sig_map.keys())
        else:
            limited_sigs = set(sig_map.keys())

        candidates = [candidate for candidate in candidates if candidate["sig"] in limited_sigs]
        inline_list = [
            (candidate["path"], candidate["method"], candidate["operationId"], candidate["location"], candidate["mediaType"], candidate["schema"])
            for candidate in candidates
        ]

    new_schemas = {}
    changed = []
    for path, method, operation_id, location, media_type, schema in inline_list:
        sig = signature(schema)
        if sig not in limited_sigs:
            continue
        type_name = type_map[sig]

        if type_name not in schemas:
            schemas[type_name] = copy.deepcopy(schema)
            new_schemas[type_name] = schemas[type_name]

        if location == "requestBody":
            target = openapi["paths"][path][method]["requestBody"]["content"][media_type]
        else:
            status = location.split("/", 1)[1]
            target = openapi["paths"][path][method]["responses"][status]["content"][media_type]

        target["schema"] = {"$ref": f"#/components/schemas/{type_name}"}
        changed.append((path, method, location, media_type, type_name))

    write_output(openapi, args.output or f"{args.input}.converted.json", args.dry_run)

    print("Conversion summary:")
    print(f"  inline schema locations touched: {len(changed)}")
    print(f"  new components added: {len(new_schemas)}")
    for path, method, location, media_type, type_name in changed:
        print(f"  - {path} [{method}] {location} {media_type} -> {type_name}")

    if new_schemas:
        print("Added schemas:")
        for name in new_schemas:
            print(f"  - {name}")

    return openapi


def dereference_ref_mode(openapi, args):
    ref_name = args.dereference_ref
    ref_value = ref_name if ref_name.startswith("#/") else f"#/components/schemas/{ref_name}"
    try:
        resolve_pointer(openapi, ref_value)
    except Exception as exc:
        raise SystemExit(f"Could not resolve ref '{ref_value}': {exc}")

    stats = {"replacements": 0, "locations": [], "current_path": "#"}
    updated = replace_ref_instances(openapi, ref_value, openapi, stats)

    if stats["replacements"] == 0:
        print(f"No usages of {ref_value} were found.")
        return openapi

    write_output(updated, args.output or f"{args.input}.dereferenced.json", args.dry_run)
    print(f"Dereferenced {ref_value} in {stats['replacements']} location(s).")
    for location in stats["locations"][:20]:
        print(f"  - {location}")
    if len(stats["locations"]) > 20:
        print(f"  ... and {len(stats['locations']) - 20} more")
    return updated


def extract_operation_mode(openapi, args):
    new_spec, path, method, operation_id, copied_ref_count, remaining_ref_count = build_operation_spec(openapi, args.operation_id)
    write_output(new_spec, args.output or f"{args.operation_id}.openapi.json", args.dry_run)
    print(f"Extracted operationId '{operation_id}' from {path} [{method}].")
    print(f"Remaining component ref target(s) copied into the standalone spec: {copied_ref_count}.")
    if remaining_ref_count == 0:
        print("Schemas were fully inlined in the extracted operation.")
    else:
        print(f"{remaining_ref_count} component ref(s) remain after inlining, typically due to recursive schemas.")
    return new_spec


def main():
    parser = argparse.ArgumentParser(description="Reshape OpenAPI specs by converting inline schemas, dereferencing refs, or extracting a single operation.")
    parser.add_argument("--input", "-i", required=True, help="Input OpenAPI JSON file path")
    parser.add_argument("--output", "-o", help="Output JSON file path")
    parser.add_argument("--dry-run", action="store_true", help="Do not write output file")

    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument("--convert-inline", action="store_true", help="Convert inline request/response schemas into component refs")
    mode_group.add_argument("--dereference-ref", help="Replace every usage of a component ref with its inline schema. Accepts 'CreateAction' or '#/components/schemas/CreateAction'")
    mode_group.add_argument("--operation-id", nargs="?", const="__interactive__", help="Generate a standalone OpenAPI spec for a single operationId. Omit the value to choose from a list")

    parser.add_argument("--type", "-t", help="Filter for --convert-inline by schema name or operationId")
    parser.add_argument("--interactive", action="store_true", help="Interactive selection for --convert-inline or --operation-id")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        raise SystemExit(f"Input file not found: {args.input}")

    if not args.convert_inline and not args.dereference_ref and args.operation_id is None:
        args.convert_inline = True

    with open(args.input, "r", encoding="utf-8") as handle:
        openapi = json.load(handle, object_pairs_hook=OrderedDict)

    if args.operation_id == "__interactive__":
        args.operation_id = choose_operation_interactively(openapi)
    elif args.interactive and args.operation_id is None and not args.convert_inline and not args.dereference_ref:
        args.operation_id = choose_operation_interactively(openapi)

    if args.convert_inline:
        convert_inline_mode(openapi, args)
    elif args.dereference_ref:
        dereference_ref_mode(openapi, args)
    else:
        extract_operation_mode(openapi, args)


if __name__ == "__main__":
    main()
