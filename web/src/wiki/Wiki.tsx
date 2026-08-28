import { useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes, useParams } from "react-router-dom";
import { BookOpen, Search } from "lucide-react";
import { PAGES, findPage, search, sections } from "./index";

export function Wiki() {
  return (
    <div className="wiki">
      <WikiNav />
      <Routes>
        <Route index element={<Navigate to="quickstart" replace />} />
        <Route path=":pageId" element={<WikiContent />} />
        <Route path="*" element={<Navigate to="quickstart" replace />} />
      </Routes>
    </div>
  );
}

function WikiNav() {
  const [query, setQuery] = useState("");
  const results = useMemo(() => search(query), [query]);
  const grouped = useMemo(() => sections(), []);

  return (
    <nav className="wiki-nav" aria-label="Documentation">
      <div className="search">
        <Search size={15} aria-hidden="true" />
        <input
          aria-label="Search the documentation"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {query.trim().length >= 2 ? (
        <>
          <h3>
            {results.length} result{results.length === 1 ? "" : "s"}
          </h3>
          <ul>
            {results.map((page) => (
              <li key={page.id}>
                <NavLink
                  to={page.id}
                  className={({ isActive }) => (isActive ? "wiki-link active" : "wiki-link")}
                  onClick={() => setQuery("")}
                >
                  {page.title}
                  <small>{page.summary}</small>
                </NavLink>
              </li>
            ))}
            {results.length === 0 && <li className="muted">Nothing matched.</li>}
          </ul>
        </>
      ) : (
        grouped.map(({ section, pages }) => (
          <div key={section}>
            <h3>{section}</h3>
            <ul>
              {pages.map((page) => (
                <li key={page.id}>
                  <NavLink
                    to={page.id}
                    className={({ isActive }) => (isActive ? "wiki-link active" : "wiki-link")}
                  >
                    {page.title}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </nav>
  );
}

function WikiContent() {
  const { pageId } = useParams();
  const page = findPage(pageId);

  if (!page) {
    return (
      <main className="wiki-page">
        <h1>Not found</h1>
        <p className="muted">No page with that name. Use the search on the left.</p>
      </main>
    );
  }

  const index = PAGES.indexOf(page);
  const previous = PAGES[index - 1];
  const next = PAGES[index + 1];
  const { Content } = page;

  return (
    <main className="wiki-page">
      <p className="wiki-breadcrumb">
        <BookOpen size={14} aria-hidden="true" />
        {page.section}
      </p>
      <h1>{page.title}</h1>
      <p className="wiki-summary">{page.summary}</p>

      <Content />

      <nav className="wiki-pager" aria-label="Nearby pages">
        {previous ? (
          <NavLink to={`../${previous.id}`} relative="path">
            ← {previous.title}
          </NavLink>
        ) : (
          <span />
        )}
        {next && (
          <NavLink to={`../${next.id}`} relative="path">
            {next.title} →
          </NavLink>
        )}
      </nav>
    </main>
  );
}
