import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";

/**
 * A link from a setting to the page that documents it.
 *
 * The console does not explain why a setting exists (CLAUDE.md §9); the wiki
 * does. This is the road between the two, so an operator looking at a field
 * they do not recognise is one click from the section about it rather than
 * guessing from the label.
 */
export function DocsLink({
  page,
  anchor,
  children,
}: {
  /** Wiki page id, as registered in web/src/wiki/index.ts. */
  page: string;
  /** Section anchor on that page. Section headings carry one automatically. */
  anchor?: string;
  children?: ReactNode;
}) {
  return (
    <Link className="docs-link" to={`/wiki/${page}${anchor ? `#${anchor}` : ""}`}>
      <BookOpen size={14} aria-hidden="true" />
      {children ?? "Documentation"}
    </Link>
  );
}

/**
 * What a setting is, in a sentence, with the way to the rest of it.
 *
 * Kept to one short paragraph on purpose: the label is the terminology, this
 * says what the thing does, and anything longer belongs on the wiki page it
 * links to.
 */
export function InfoPanel({
  children,
  page,
  anchor,
  linkLabel,
}: {
  children: ReactNode;
  page: string;
  anchor?: string;
  linkLabel?: string;
}) {
  return (
    <aside className="info-panel">
      <p>{children}</p>
      <DocsLink page={page} anchor={anchor}>
        {linkLabel}
      </DocsLink>
    </aside>
  );
}
