"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

type OperationSummary = {
  path: string;
  method: string;
  operationId: string;
  summary: string;
};

type TransformResponse = {
  fileName: string;
  generatedAt: string;
  json: string;
};

export default function HomePage() {
  const previewStep = 100;
  const [operations, setOperations] = useState<OperationSummary[]>([]);
  const [mode, setMode] = useState<"full" | "operations">("operations");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(["createAction"]);
  const [output, setOutput] = useState<TransformResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("https://api.getmembrane.com/docs-json");
  const [specTitle, setSpecTitle] = useState("Membrane API");
  const [loadingOps, setLoadingOps] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [visibleLineCount, setVisibleLineCount] = useState(previewStep);

  useEffect(() => {
    let active = true;

    async function loadOperations() {
      setLoadingOps(true);
      setError(null);

      try {
        const response = await fetch("/api/operations");
        const payload = (await response.json()) as {
          operations?: OperationSummary[];
          specTitle?: string;
          sourceUrl?: string;
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "Unable to load operations.");
        }

        if (!active) {
          return;
        }

        setOperations(payload.operations ?? []);
        setSpecTitle(payload.specTitle ?? "Membrane API");
        setSourceUrl(payload.sourceUrl ?? "https://api.getmembrane.com/docs-json");
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load operations.");
        }
      } finally {
        if (active) {
          setLoadingOps(false);
        }
      }
    }

    void loadOperations();

    return () => {
      active = false;
    };
  }, []);

  const filteredOperations = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    if (!lowered) {
      return operations;
    }
    return operations.filter((operation) =>
      [operation.operationId, operation.method, operation.path, operation.summary]
        .join(" ")
        .toLowerCase()
        .includes(lowered),
    );
  }, [operations, query]);

  function toggleOperation(operationId: string) {
    setSelected((current) =>
      current.includes(operationId) ? current.filter((item) => item !== operationId) : [...current, operationId],
    );
  }

  function selectVisible() {
    setSelected(Array.from(new Set([...selected, ...filteredOperations.map((item) => item.operationId)])));
  }

  function clearVisible() {
    const visible = new Set(filteredOperations.map((item) => item.operationId));
    setSelected((current) => current.filter((item) => !visible.has(item)));
  }

  function runTransform() {
    setError(null);

    startTransition(async () => {
      try {
        const response = await fetch("/api/transform", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            mode === "full"
              ? { mode: "full" }
              : {
                  mode: "operations",
                  operationIds: selected,
                },
          ),
        });

        const payload = (await response.json()) as TransformResponse & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Transformation failed.");
        }

        setOutput(payload);
        setVisibleLineCount(previewStep);
      } catch (transformError) {
        setError(transformError instanceof Error ? transformError.message : "Transformation failed.");
      }
    });
  }

  const downloadHref = useMemo(() => {
    if (!output) {
      return null;
    }
    return `data:application/json;charset=utf-8,${encodeURIComponent(output.json)}`;
  }, [output]);

  const outputLines = useMemo(() => (output ? output.json.split("\n") : []), [output]);
  const visibleLines = useMemo(() => outputLines.slice(0, visibleLineCount), [outputLines, visibleLineCount]);
  const hasMoreLines = visibleLineCount < outputLines.length;

  return (
    <main className="shell">
      <section className="hero">
        <span className="eyebrow">Live OpenAPI Workbench</span>
        <h1>Shape the Membrane spec into the file you actually need.</h1>
        <p>
          This app fetches the latest OpenAPI document from{" "}
          <a href={sourceUrl} target="_blank" rel="noreferrer">
            api.getmembrane.com/docs-json
          </a>
          , then either dereferences the whole thing or exports one or more selected operations as a browser-ready JSON
          file.
        </p>
      </section>

      <section className="grid">
        <aside className="panel">
          <div className="panel-inner controls">
            <div>
              <h2 className="section-title">Transform</h2>
              <p className="muted">
                Source spec: <strong>{specTitle}</strong>
              </p>
            </div>

            <div className="mode-toggle">
              <button className={`card-button ${mode === "full" ? "active" : ""}`} onClick={() => setMode("full")}>
                <strong>Whole spec</strong>
                <div className="muted">Dereference every operation and schema into one export.</div>
              </button>

              <button
                className={`card-button ${mode === "operations" ? "active" : ""}`}
                onClick={() => setMode("operations")}
              >
                <strong>Selected operations</strong>
                <div className="muted">Choose one or more operationIds and generate a smaller dereferenced spec.</div>
              </button>
            </div>

            {mode === "operations" ? (
              <>
                <input
                  className="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by operationId, method, path, or summary"
                />

                <div className="actions">
                  <button className="secondary" onClick={selectVisible} disabled={loadingOps || filteredOperations.length === 0}>
                    Select visible
                  </button>
                  <button className="secondary" onClick={clearVisible} disabled={loadingOps || selected.length === 0}>
                    Clear visible
                  </button>
                </div>

                <div className="ops-list">
                  {loadingOps ? (
                    <div className="muted">Loading operationIds from the live spec...</div>
                  ) : (
                    filteredOperations.map((operation) => (
                      <label key={`${operation.method}-${operation.operationId}-${operation.path}`} className="op-item">
                        <input
                          type="checkbox"
                          checked={selected.includes(operation.operationId)}
                          onChange={() => toggleOperation(operation.operationId)}
                        />
                        <span>
                          <code>{operation.method}</code>
                          <strong>{operation.operationId}</strong>
                          <div>{operation.path}</div>
                          {operation.summary ? <div className="muted">{operation.summary}</div> : null}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="card-button active">
                <strong>Full export mode</strong>
                <div className="muted">Selected operations are ignored and the complete spec is expanded inline.</div>
              </div>
            )}

            <div className="status">
              {mode === "operations" ? `${selected.length} operation(s) selected.` : "Whole-spec export selected."}
            </div>

            <div className="actions">
              <button
                className="primary"
                onClick={runTransform}
                disabled={isPending || loadingOps || (mode === "operations" && selected.length === 0)}
              >
                {isPending ? "Generating..." : "Generate JSON"}
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setOutput(null);
                  setVisibleLineCount(previewStep);
                }}
                disabled={!output}
              >
                Clear preview
              </button>
            </div>

            {error ? <div className="muted">{error}</div> : null}
          </div>
        </aside>

        <section className="panel preview">
          <div className="panel-inner preview-head">
            <div>
              <h2 className="section-title">Preview</h2>
              <div className="muted">Generate the file, inspect it here, then download it when it looks right.</div>
            </div>

            {downloadHref && output ? (
              <a className="primary" href={downloadHref} download={output.fileName}>
                Download JSON
              </a>
            ) : null}
          </div>

          <div className="panel-inner">
            <div className="pill-row">
              <span className="pill">Mode: {mode === "full" ? "Whole spec" : "Selected operations"}</span>
              {output ? <span className="pill">File: {output.fileName}</span> : null}
              {output ? <span className="pill">Generated: {new Date(output.generatedAt).toLocaleString()}</span> : null}
              {output ? <span className="pill">Previewing: {Math.min(visibleLineCount, outputLines.length)} / {outputLines.length} lines</span> : null}
            </div>
          </div>

          <div className="panel-inner json-frame">
            <pre>{output ? visibleLines.join("\n") : "Your generated JSON will appear here."}</pre>
          </div>

          {output ? (
            <div className="panel-inner preview-actions">
              <div className="muted">
                Large files stay collapsed to keep the browser stable. Expand the preview in 100-line chunks or use the
                download button for the full file.
              </div>

              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => setVisibleLineCount((current) => Math.min(current + previewStep, outputLines.length))}
                  disabled={!hasMoreLines}
                >
                  Show 100 more lines
                </button>
                <button
                  className="secondary"
                  onClick={() => setVisibleLineCount(outputLines.length)}
                  disabled={!hasMoreLines}
                >
                  Show all lines
                </button>
                <button
                  className="secondary"
                  onClick={() => setVisibleLineCount(previewStep)}
                  disabled={visibleLineCount <= previewStep}
                >
                  Reset preview
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
