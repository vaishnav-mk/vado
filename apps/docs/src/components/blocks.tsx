import { ArrowRightIcon, CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { DocLink } from "./doc-link";

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = { idle: "Copy", copied: "Copied", failed: "Select and copy below" };

export function Code({ children, label = "Example" }: { children: string; label?: string }) {
  const [state, setState] = useState<CopyState>("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="code-block">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-[10px] text-muted">
        <span>{label}</span>
        <button
          type="button"
          aria-label={state === "copied" ? "Copied" : "Copy code"}
          className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:text-ink"
          onClick={copy}
        >
          {state === "copied" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          {COPY_LABEL[state]}
        </button>
      </div>
      <pre tabIndex={0}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <aside className="notice">{children}</aside>;
}

export function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={headers.join(", ")}>
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) =>
                column === 0 ? (
                  <th key={column} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={column}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Flow({ items }: { items: string[] }) {
  return (
    <div className="arrow-line" role="list">
      {items.map((item, index) => (
        <div className="contents" key={item}>
          {index > 0 && <ArrowRightIcon className="flow-arrow size-4 shrink-0" aria-hidden="true" />}
          <div className="flow-box" role="listitem">
            {item}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface Card {
  slug: string;
  title: string;
  text: string;
}

export function CardLinks({ items }: { items: Card[] }) {
  return (
    <div className="card-links">
      {items.map((item) => (
        <DocLink className="doc-card" key={item.slug} slug={item.slug}>
          <strong>
            {item.title}
            <ArrowRightIcon size={13} aria-hidden="true" />
          </strong>
          <p>{item.text}</p>
        </DocLink>
      ))}
    </div>
  );
}
