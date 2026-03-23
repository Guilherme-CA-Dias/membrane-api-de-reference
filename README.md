# Membrane OpenAPI Tools

Small tools for reshaping the Membrane OpenAPI spec.

This repo currently includes:

- a Next.js app that fetches the live spec from `https://api.getmembrane.com/docs-json`
- a Python script for working with a local OpenAPI JSON file

## What The App Does

The web app lets you:

- dereference the whole OpenAPI spec
- select one or more `operationId` values and export a smaller dereferenced spec
- preview the generated JSON in the browser
- download the generated file

To keep the browser stable, the preview is paged in chunks of 100 lines instead of rendering the full JSON at once.

## Run The Next.js App

Install dependencies:

```bash
npm install
```

Start the app locally:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

Create a production build:

```bash
npm run build
```

## How To Use The App

1. Open the app in the browser.
2. Choose `Whole spec` or `Selected operations`.
3. If using `Selected operations`, filter and select one or more operations.
4. Click `Generate JSON`.
5. Review the preview in 100-line chunks if needed.
6. Click `Download JSON` to save the generated file.

## Python Script

The Python helper is:

`convert_inline_schemas.py`

It supports three main workflows:

- convert inline request/response schemas into component refs
- replace usages of a component ref with inline schema content
- extract one operation into a dereferenced standalone OpenAPI file

## Python Script Examples

Convert inline schemas to component refs:

```bash
python convert_inline_schemas.py -i .\Untitled-1.json --convert-inline
```

Dereference a component everywhere it is used:

```bash
python convert_inline_schemas.py -i .\Untitled-1.json --dereference-ref CreateAction
```

Extract a single operation into a standalone dereferenced file:

```bash
python convert_inline_schemas.py -i .\Untitled-1.json --operation-id createAction -o .\createAction.json
```

Choose an operation interactively:

```bash
python convert_inline_schemas.py -i .\Untitled-1.json --operation-id
```

## Project Structure

- `app/page.tsx`: main UI
- `app/api/operations/route.ts`: loads operation list from the live spec
- `app/api/transform/route.ts`: generates dereferenced JSON output
- `lib/openapi.ts`: shared OpenAPI transformation logic
- `convert_inline_schemas.py`: local CLI utility

## Notes

- The app fetches the live spec from `api.getmembrane.com/docs-json`.
- Exported operation files are dereferenced inline.
- Recursive schema branches are truncated during full dereferencing to avoid infinite recursion.
