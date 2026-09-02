import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Building blocks every wiki page is composed from.
 *
 * A page is always a <Quickstart> followed by <Details>. Keeping the shape
 * in these components rather than in each page keeps the whole wiki
 * consistent as it grows.
 */

export function Quickstart({ children }: { children: ReactNode }) {
  return (
    <section className="wiki-quickstart" aria-labelledby="quickstart">
      <h2 id="quickstart">Quickstart</h2>
      {children}
    </section>
  );
}

export function Details({ children }: { children: ReactNode }) {
  return (
    <section className="wiki-details" aria-labelledby="details">
      <h2 id="details">Details</h2>
      {children}
    </section>
  );
}

/**
 * A titled part of a page.
 *
 * The heading carries an anchor derived from its title, so the console can
 * link straight at the section documenting a setting rather than at the top
 * of a long page. Pass `id` where a link should keep working after a title is
 * reworded.
 */
export function Section({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: ReactNode;
}) {
  const anchor = id ?? slug(title);
  return (
    <section className="wiki-section" id={anchor}>
      <h3>
        <a href={`#${anchor}`} className="wiki-anchor" aria-label={`Link to ${title}`}>
          {title}
        </a>
      </h3>
      {children}
    </section>
  );
}

/** The anchor a section title becomes: lower case, words joined by dashes. */
export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** A numbered procedure. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="wiki-steps">{children}</ol>;
}

/** A worked example: a short title and the concrete thing to do or type. */
export function Example({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wiki-example">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className="wiki-code">{children}</pre>;
}

/** Inline path, command, field name or value. */
export function C({ children }: { children: ReactNode }) {
  return <code className="wiki-inline">{children}</code>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="wiki-note">{children}</p>;
}

/** A reference table. Rows are [term, description] or wider. */
export function Reference({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="wiki-table-wrap">
      <table className="data compact">
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
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Where a feature lives in the console. */
export function Where({ children }: { children: ReactNode }) {
  return (
    <p className="wiki-where">
      <strong>In the console:</strong> {children}
    </p>
  );
}

/** A link to another wiki page, or to a section of one. */
export function PageLink({
  page,
  anchor,
  children,
}: {
  page: string;
  anchor?: string;
  children: ReactNode;
}) {
  return (
    <Link className="wiki-page-link" to={`/wiki/${page}${anchor ? `#${anchor}` : ""}`}>
      {children}
    </Link>
  );
}
