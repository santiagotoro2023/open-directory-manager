import type { WikiPage } from "./types";

import * as administrativeTemplates from "./pages/admx";
import * as agent from "./pages/agent";
import * as architecture from "./pages/architecture";
import * as audit from "./pages/audit";
import * as certificates from "./pages/certificates";
import * as controllers from "./pages/controllers";
import * as delegation from "./pages/delegation";
import * as dhcp from "./pages/dhcp";
import * as directory from "./pages/directory";
import * as dns from "./pages/dns";
import * as domainJoin from "./pages/domain-join";
import * as glossary from "./pages/glossary";
import * as groupPolicy from "./pages/group-policy";
import * as operations from "./pages/operations";
import * as policySettings from "./pages/policy-settings";
import * as networkAccess from "./pages/network-access";
import * as passwords from "./pages/passwords";
import * as printing from "./pages/printing";
import * as remoteAccess from "./pages/remote-access";
import * as quickstart from "./pages/quickstart";
import * as recycleBin from "./pages/recycle-bin";
import * as roles from "./pages/roles";
import * as servers from "./pages/servers";
import * as shares from "./pages/shares";
import * as troubleshooting from "./pages/troubleshooting";

/**
 * The wiki registry.
 *
 * Adding a page: create pages/<id>.tsx exporting `meta` and `Content`, then
 * add it to this list. Nothing else needs to change — the sidebar, search and
 * routing are all driven from here.
 */
const MODULES = [
  quickstart,
  directory,
  groupPolicy,
  policySettings,
  passwords,
  administrativeTemplates,
  dns,
  dhcp,
  certificates,
  agent,
  domainJoin,
  delegation,
  roles,
  servers,
  shares,
  printing,
  remoteAccess,
  networkAccess,
  controllers,
  recycleBin,
  operations,
  audit,
  architecture,
  glossary,
  troubleshooting,
];

export const PAGES: WikiPage[] = MODULES.map((module) => ({
  ...module.meta,
  Content: module.Content,
}));

/** Sidebar order. A section not listed here is appended alphabetically. */
export const SECTION_ORDER = [
  "Start here",
  "Managing the domain",
  "Network services",
  "Clients",
  "Administration",
  "Reference",
];

export function sections(): { section: string; pages: WikiPage[] }[] {
  const grouped = new Map<string, WikiPage[]>();
  for (const page of PAGES) {
    const existing = grouped.get(page.section) ?? [];
    existing.push(page);
    grouped.set(page.section, existing);
  }
  const known = SECTION_ORDER.filter((section) => grouped.has(section));
  const extra = [...grouped.keys()].filter((section) => !SECTION_ORDER.includes(section)).sort();
  return [...known, ...extra].map((section) => ({
    section,
    pages: grouped.get(section) ?? [],
  }));
}

export function findPage(id: string | undefined): WikiPage | undefined {
  return PAGES.find((page) => page.id === id);
}

/** Title, summary and keyword search. */
export function search(query: string): WikiPage[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  return PAGES.filter((page) =>
    [page.title, page.summary, page.section, ...(page.keywords ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}
