import type { ComponentType } from "react";

export interface WikiPageMeta {
  /** URL fragment: /wiki/<id> */
  id: string;
  title: string;
  /** Sidebar grouping. Add a new one by using it here and in SECTION_ORDER. */
  section: string;
  /** One line shown in search results and on the wiki index. */
  summary: string;
  /** Extra words the search should match. */
  keywords?: string[];
}

export interface WikiPage extends WikiPageMeta {
  Content: ComponentType;
}
