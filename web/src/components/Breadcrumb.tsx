import { Link } from "react-router-dom";

/**
 * Where an object lives, as a path somebody can read and click, instead of
 * a distinguished name somebody has to parse. Each container is a link that
 * opens the directory there; the raw name stays available on hover, for
 * whoever needs to paste it.
 */
export function splitDn(dn: string): { attribute: string; value: string; dn: string }[] {
  // Commas escaped with a backslash are part of a value, not a separator.
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i];
    if (c === "\\" && i + 1 < dn.length) {
      current += c + dn[i + 1];
      i++;
    } else if (c === ",") {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current) parts.push(current);
  return parts.map((part, index) => {
    const [attribute, ...rest] = part.split("=");
    return {
      attribute: (attribute ?? "").trim().toUpperCase(),
      value: rest.join("=").replace(/\\(.)/g, "$1").trim(),
      dn: parts.slice(index).join(","),
    };
  });
}

export function Breadcrumb({ dn }: { dn: string }) {
  const parts = splitDn(dn);
  const domain = parts.filter((p) => p.attribute === "DC");
  const containers = parts.filter((p) => p.attribute !== "DC").reverse();
  const domainDn = domain.map((p) => `${p.attribute}=${p.value}`).join(",");
  const leaf = containers.pop();

  return (
    <nav className="breadcrumb path" aria-label="Location" title={dn}>
      <Link to={`/directory?container=${encodeURIComponent(domainDn)}`}>
        {domain[0]?.value.toUpperCase() ?? "domain"}
      </Link>
      {containers.map((part) => (
        <span key={part.dn}>
          <span className="path-sep" aria-hidden="true">
            ›
          </span>
          <Link to={`/directory?container=${encodeURIComponent(part.dn)}`}>{part.value}</Link>
        </span>
      ))}
      {leaf && (
        <span>
          <span className="path-sep" aria-hidden="true">
            ›
          </span>
          <span className="path-leaf">{leaf.value}</span>
        </span>
      )}
    </nav>
  );
}
