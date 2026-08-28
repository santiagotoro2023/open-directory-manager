"""ADMX/ADML parsing and expansion.

Administrators upload the ADMX plus ADML files a vendor already ships
(Chrome, Firefox, and anything else that follows the schema). This module
parses them into typed definitions the UI renders as form controls, and
expands the resulting selections into settings the agent can actually apply
(CLAUDE.md §3.6).

The XML arrives from an upload, so it is parsed with defusedxml and bounded
in size and element count. ADMX is a documented schema; this is a real
parser, not a pattern match.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from defusedxml import ElementTree as DefusedET

NS = "{http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions}"

MAX_BYTES = 8 * 1024 * 1024
MAX_POLICIES = 5000
MAX_ELEMENTS = 64

# $(string.Foo) / $(presentation.Foo)
_REFERENCE = re.compile(r"^\$\((?P<kind>string|presentation)\.(?P<id>[^)]+)\)$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

# Registry roots ODM knows how to turn into something a Debian client obeys.
# Everything else parses and stores fine, but reports as unsupported rather
# than silently doing nothing.
BROWSER_ROOTS: tuple[tuple[str, str], ...] = (
    (r"software\policies\google\chrome", "chromium"),
    (r"software\policies\chromium", "chromium"),
    (r"software\policies\mozilla\firefox", "firefox"),
)


class AdmxError(Exception):
    """The uploaded template could not be parsed."""


@dataclass
class Element:
    id: str
    type: str  # boolean | decimal | text | enum | list | multiText
    value_name: str = ""
    label: str = ""
    required: bool = False
    default: Any = None
    minimum: int | None = None
    maximum: int | None = None
    max_length: int | None = None
    # enum only: [{"label": ..., "value": ...}]
    items: list[dict[str, Any]] = field(default_factory=list)
    # list only: values are written under this key rather than one value name
    key: str = ""
    explicit_value: bool = False

    def as_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "value_name": self.value_name,
            "label": self.label,
            "required": self.required,
            "default": self.default,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "max_length": self.max_length,
            "items": self.items,
            "key": self.key,
            "explicit_value": self.explicit_value,
        }


@dataclass
class Policy:
    id: str  # namespace:name
    name: str
    display_name: str
    explain_text: str
    policy_class: str  # Machine | User | Both
    category: str
    registry_key: str
    value_name: str
    supported_on: str
    enabled_value: Any
    disabled_value: Any
    elements: list[Element]


@dataclass
class Category:
    name: str  # qualified with the template prefix
    display_name: str
    parent: str | None


@dataclass
class Template:
    namespace: str
    prefix: str
    display_name: str
    revision: str
    categories: list[Category]
    policies: list[Policy]


def parse(admx: bytes, adml: bytes | None, file_name: str) -> Template:
    """Parse one ADMX file with its ADML companion."""
    if len(admx) > MAX_BYTES or (adml is not None and len(adml) > MAX_BYTES):
        raise AdmxError("template files must be 8 MB or smaller")

    strings, presentations = _parse_adml(adml)
    root = _xml(admx)
    if not root.tag.endswith("policyDefinitions"):
        raise AdmxError("not an ADMX policy definitions file")

    namespaces = root.find(f"{NS}policyNamespaces")
    target = namespaces.find(f"{NS}target") if namespaces is not None else None
    if target is None:
        raise AdmxError("ADMX file declares no target namespace")
    namespace = target.get("namespace", "").strip()
    prefix = target.get("prefix", "").strip()
    if not namespace or not _SAFE_ID.match(namespace):
        raise AdmxError("invalid target namespace")

    supported = {
        definition.get("name", ""): _resolve(definition.get("displayName"), strings)
        for definition in root.findall(
            f"{NS}supportedOn/{NS}definitions/{NS}definition"
        )
        if definition.get("name")
    }

    categories = [
        Category(
            name=_qualify(prefix, element.get("name", "")),
            display_name=_resolve(element.get("displayName"), strings),
            parent=_parent_ref(element, prefix),
        )
        for element in root.findall(f"{NS}categories/{NS}category")
        if element.get("name")
    ]

    policy_elements = root.findall(f"{NS}policies/{NS}policy")
    if len(policy_elements) > MAX_POLICIES:
        raise AdmxError(f"template declares more than {MAX_POLICIES} policies")

    policies = [
        policy
        for policy in (
            _parse_policy(element, namespace, prefix, strings, presentations, supported)
            for element in policy_elements
        )
        if policy is not None
    ]

    return Template(
        namespace=namespace,
        prefix=prefix,
        display_name=strings.get("__display__") or file_name,
        revision=root.get("revision", ""),
        categories=categories,
        policies=policies,
    )


def _xml(payload: bytes):
    try:
        # defusedxml refuses entity expansion, external entities and DTD
        # retrieval, which is what makes parsing an uploaded file safe.
        return DefusedET.fromstring(payload)
    except Exception as exc:
        raise AdmxError(f"malformed XML: {exc}") from exc


def _parse_adml(adml: bytes | None) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    """Return the string table and, per presentation, refId -> label."""
    if not adml:
        return {}, {}
    root = _xml(adml)
    strings = {
        element.get("id", ""): (element.text or "").strip()
        for element in root.findall(f".//{NS}stringTable/{NS}string")
        if element.get("id")
    }
    display = root.find(f"{NS}displayName")
    if display is not None and display.text:
        strings["__display__"] = display.text.strip()

    presentations: dict[str, dict[str, str]] = {}
    for presentation in root.findall(f".//{NS}presentationTable/{NS}presentation"):
        identifier = presentation.get("id")
        if not identifier:
            continue
        labels: dict[str, str] = {}
        for child in presentation:
            ref = child.get("refId")
            if not ref:
                continue
            label = child.find(f"{NS}label")
            if label is not None and label.text:
                labels[ref] = label.text.strip().rstrip(":")
            elif child.text and child.text.strip():
                labels[ref] = child.text.strip().rstrip(":")
        presentations[identifier] = labels
    return strings, presentations


def _resolve(reference: str | None, strings: dict[str, str]) -> str:
    if not reference:
        return ""
    match = _REFERENCE.match(reference.strip())
    if not match:
        return reference.strip()
    if match.group("kind") == "presentation":
        return ""
    return strings.get(match.group("id"), match.group("id"))


def _presentation_id(reference: str | None) -> str:
    match = _REFERENCE.match((reference or "").strip())
    return match.group("id") if match and match.group("kind") == "presentation" else ""


def _qualify(prefix: str, name: str) -> str:
    return f"{prefix}:{name}" if prefix and ":" not in name else name


def _parent_ref(element, prefix: str) -> str | None:
    parent = element.find(f"{NS}parentCategory")
    if parent is None:
        return None
    ref = parent.get("ref", "")
    return _qualify(prefix, ref) if ref else None


def _parse_policy(element, namespace, prefix, strings, presentations, supported) -> Policy | None:
    name = element.get("name")
    if not name or not _SAFE_ID.match(name):
        return None

    labels = presentations.get(_presentation_id(element.get("presentation")), {})
    elements = _parse_elements(element.find(f"{NS}elements"), labels, strings)

    return Policy(
        id=f"{namespace}:{name}",
        name=name,
        display_name=_resolve(element.get("displayName"), strings) or name,
        explain_text=_resolve(element.get("explainText"), strings),
        policy_class=element.get("class", "Both"),
        category=_parent_ref(element, prefix) or "",
        registry_key=(element.get("key") or "").strip("\\"),
        value_name=element.get("valueName", ""),
        supported_on=_supported_on(element, supported),
        enabled_value=_value_of(element.find(f"{NS}enabledValue")),
        disabled_value=_value_of(element.find(f"{NS}disabledValue")),
        elements=elements,
    )


def _supported_on(element, supported: dict[str, str]) -> str:
    """<supportedOn ref="X"/> names a definition, which carries the label."""
    node = element.find(f"{NS}supportedOn")
    if node is None:
        return ""
    ref = (node.get("ref") or "").split(":")[-1]
    return supported.get(ref, ref)


def _value_of(node) -> Any:
    """<enabledValue><decimal value="1"/></enabledValue> -> 1"""
    if node is None:
        return None
    for child in node:
        tag = child.tag.removeprefix(NS)
        if tag == "decimal" or tag == "longDecimal":
            try:
                return int(child.get("value", "0"))
            except ValueError:
                return 0
        if tag == "string":
            return (child.text or "").strip()
        if tag == "delete":
            return None
    return None


def _parse_elements(container, labels: dict[str, str], strings: dict[str, str]) -> list[Element]:
    if container is None:
        return []
    elements: list[Element] = []
    for child in list(container)[:MAX_ELEMENTS]:
        kind = child.tag.removeprefix(NS)
        identifier = child.get("id") or child.get("valueName") or kind
        if not _SAFE_ID.match(identifier):
            continue

        element = Element(
            id=identifier,
            type=kind,
            value_name=child.get("valueName", ""),
            label=labels.get(identifier, ""),
            required=child.get("required", "false").lower() == "true",
        )
        if kind == "decimal" or kind == "longDecimal":
            element.type = "decimal"
            element.minimum = _int(child.get("minValue"))
            element.maximum = _int(child.get("maxValue"))
        elif kind == "text" or kind == "multiText":
            element.max_length = _int(child.get("maxLength"))
        elif kind == "boolean":
            element.default = False
        elif kind == "enum":
            for item in child.findall(f"{NS}item"):
                elements_value = _value_of(item.find(f"{NS}value"))
                element.items.append(
                    {
                        "label": _resolve(item.get("displayName"), strings),
                        "value": elements_value,
                    }
                )
        elif kind == "list":
            element.key = (child.get("key") or "").strip("\\")
            element.explicit_value = child.get("explicitValue", "false").lower() == "true"
        else:
            continue
        elements.append(element)
    return elements


# ------------------------------------------------------------------ expand ---


def target_of(registry_key: str) -> tuple[str, str] | None:
    """Map a registry key to (browser, sub-path) if ODM can apply it."""
    lowered = registry_key.replace("/", "\\").lower().strip("\\")
    for root, browser in BROWSER_ROOTS:
        if lowered == root:
            return browser, ""
        if lowered.startswith(root + "\\"):
            return browser, registry_key[len(root) + 1 :]
    return None


def expand(
    selections: list[dict[str, Any]], definitions: dict[str, Policy]
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    """Turn stored ADMX selections into browser managed-policy documents.

    Returns the per-browser settings and a note for every selection ODM
    cannot apply on Debian, so RSoP can explain the gap instead of the
    setting quietly doing nothing.
    """
    out: dict[str, dict[str, Any]] = {}
    notes: list[dict[str, str]] = []

    for selection in selections:
        policy = definitions.get(str(selection.get("policy_id", "")))
        if policy is None:
            notes.append(
                {"policy": str(selection.get("policy_id", "")), "reason": "template not imported"}
            )
            continue

        target = target_of(policy.registry_key)
        if target is None:
            notes.append(
                {
                    "policy": policy.id,
                    "reason": f"no Debian equivalent for {policy.registry_key or 'this key'}",
                }
            )
            continue

        browser, sub_path = target
        if browser != "firefox":
            # Chromium reads one flat JSON object; the registry sub-keys are
            # a Windows-only way of expressing list values.
            sub_path = ""
        document = out.setdefault(browser, {})
        state = selection.get("state", "enabled")

        if state == "disabled":
            if policy.disabled_value is not None and policy.value_name:
                _place(document, sub_path, policy.value_name, policy.disabled_value)
            else:
                notes.append({"policy": policy.id, "reason": "no disabled value defined"})
            continue

        values = selection.get("values") or {}
        if not policy.elements:
            value = policy.enabled_value if policy.enabled_value is not None else True
            if policy.value_name:
                _place(document, sub_path, policy.value_name, value)
            continue

        for element in policy.elements:
            if element.id not in values:
                continue
            raw = values[element.id]
            name = element.value_name or element.id
            if element.type == "list":
                _place(document, sub_path, name, list(raw) if isinstance(raw, list) else [raw])
            elif element.type == "decimal":
                _place(document, sub_path, name, _int(str(raw)) or 0)
            elif element.type == "boolean":
                _place(document, sub_path, name, bool(raw))
            else:
                _place(document, sub_path, name, raw)

    return out, notes


def _place(document: dict[str, Any], sub_path: str, value_name: str, value: Any) -> None:
    """Nest a value under the registry sub-key, the way Firefox expects."""
    cursor = document
    for part in [segment for segment in sub_path.split("\\") if segment]:
        nested = cursor.get(part)
        if not isinstance(nested, dict):
            nested = {}
            cursor[part] = nested
        cursor = nested
    cursor[value_name] = value


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None
