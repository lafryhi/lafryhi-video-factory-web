"use client";

import { useMemo, useState } from "react";
import type { ToolDefinition } from "../lib/tools";

const COMING_SOON_MESSAGE =
  "Coming Soon. Video processing will be enabled in the next development phase.";

export function ToolWorkspace({ tool }: { tool: ToolDefinition }) {
  const [files, setFiles] = useState<File[]>([]);
  const [showPlaceholder, setShowPlaceholder] = useState(false);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files]
  );

  function processFile() {
    if (!files[0]) return;
    setShowPlaceholder(true);
  }

  return (
    <section className="workspace">
      <label className="dropzone">
        <input
          type="file"
          accept={tool.accept}
          multiple={tool.multiple}
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []));
            setShowPlaceholder(false);
          }}
        />
        <span className="drop-icon">↑</span>
        <strong>Select {tool.multiple ? "files" : "a file"}</strong>
        <small>Files stay on your device and are processed in your browser.</small>
      </label>

      {files.length ? (
        <div className="selection">
          <div>
            <strong>
              {files.length === 1 ? files[0].name : `${files.length} files selected`}
            </strong>
            <small>{(totalSize / 1024 / 1024).toFixed(2)} MB</small>
          </div>
          <button onClick={processFile}>{`Start ${tool.title}`}</button>
        </div>
      ) : null}

      {showPlaceholder ? <p className="error">{COMING_SOON_MESSAGE}</p> : null}
    </section>
  );
}
