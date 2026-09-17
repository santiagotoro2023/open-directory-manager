"""Firefox and Chromium settings, typed, and how they become native policy.

An administrator sets a start page, a bookmark folder, an extension to
install and a password manager to allow, in the console's own words; what
the machine receives is the browser's own managed policy — Firefox's
policies.json and Chromium's managed JSON — with the documented policy names
for each. The translation is here, once, and tested; the agent writes the
result as it always has (apply/desktop.go), and an imported ADMX template
still works beside it, with the typed setting winning where both name the
same policy.

Every choice is a three-way one — leave the browser alone, allow, or block —
because "not set" and "allowed" are different things: a policy that sets
nothing about the password manager lets people decide; one that allows it
stops another policy from blocking it.
"""

from __future__ import annotations

from typing import Any

from .policy_schema import BrowserSettings


def _tristate(value: str) -> bool | None:
    if value == "allow":
        return True
    if value == "block":
        return False
    return None


def firefox(s: BrowserSettings) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if s.homepage or s.start_page != "unset":
        home: dict[str, Any] = {}
        if s.homepage:
            home["URL"] = s.homepage
            home["Locked"] = s.homepage_locked
        if s.start_page != "unset":
            home["StartPage"] = {
                "homepage": "homepage",
                "previous-session": "previous-session",
                "new-tab": "none",
            }[s.start_page]
        out["Homepage"] = home
    if s.bookmarks:
        out["ManagedBookmarks"] = [{"toplevel_name": s.bookmarks_folder or "Bookmarks"}] + [
            {"name": entry.name, "url": entry.url} for entry in s.bookmarks
        ]
    if s.bookmarks_bar != "unset":
        out["DisplayBookmarksToolbar"] = "always" if s.bookmarks_bar == "always" else "never"
    extensions: dict[str, Any] = {}
    if s.extensions_user_install == "block":
        extensions["*"] = {
            "installation_mode": "blocked",
            "blocked_install_message": "Extensions are installed by your organisation.",
        }
    for entry in s.extensions_install:
        identifier, url = _firefox_extension(entry)
        extensions[identifier] = {"installation_mode": "force_installed", "install_url": url}
    for entry in s.extensions_block:
        extensions[entry] = {"installation_mode": "blocked"}
    if extensions:
        out["ExtensionSettings"] = extensions
    if (value := _tristate(s.password_manager)) is not None:
        out["PasswordManagerEnabled"] = value
    if (value := _tristate(s.autofill)) is not None:
        out["AutofillAddressEnabled"] = value
        out["AutofillCreditCardEnabled"] = value
    if s.history == "clear-on-exit":
        out["SanitizeOnShutdown"] = {
            "History": True, "Cache": True, "Downloads": True, "FormData": True, "Locked": True,
        }
    elif s.history == "disabled":
        out.setdefault("Preferences", {})["places.history.enabled"] = {
            "Value": False, "Status": "locked",
        }
        out["DisableFormHistory"] = True
    if (value := _tristate(s.private_browsing)) is not None:
        out["DisablePrivateBrowsing"] = not value
    if (value := _tristate(s.developer_tools)) is not None:
        out["DisableDeveloperTools"] = not value
    if (value := _tristate(s.telemetry)) is not None:
        out["DisableTelemetry"] = not value
    if (value := _tristate(s.sync_accounts)) is not None:
        out["DisableFirefoxAccounts"] = not value
    if (value := _tristate(s.popups)) is not None:
        out["PopupBlocking"] = {"Default": not value, "Locked": True}
    if s.default_search:
        search: dict[str, Any] = {"Default": s.default_search}
        if s.default_search_url:
            search["Add"] = [{"Name": s.default_search, "URLTemplate": s.default_search_url}]
        out["SearchEngines"] = search
    if s.download_directory:
        out["DefaultDownloadDirectory"] = s.download_directory
        out["PromptForDownloadLocation"] = False
    if s.proxy_mode != "unset":
        proxy: dict[str, Any] = {"Locked": True}
        modes = {"system": "system", "none": "none", "manual": "manual", "pac": "autoConfig"}
        proxy["Mode"] = modes[s.proxy_mode]
        if s.proxy_mode == "manual" and s.proxy_server:
            proxy["HTTPProxy"] = s.proxy_server
            proxy["SSLProxy"] = s.proxy_server
            proxy["UseHTTPProxyForAllProtocols"] = True
        if s.proxy_mode == "pac" and s.proxy_pac_url:
            proxy["AutoConfigURL"] = s.proxy_pac_url
        if s.proxy_bypass:
            proxy["Passthrough"] = ", ".join(s.proxy_bypass)
        out["Proxy"] = proxy
    if s.blocked_sites or s.allowed_sites:
        out["WebsiteFilter"] = {"Block": list(s.blocked_sites), "Exceptions": list(s.allowed_sites)}
    if s.first_run_pages == "hide":
        out["OverrideFirstRunPage"] = ""
        out["OverridePostUpdatePage"] = ""
        out["NoDefaultBookmarks"] = True
    if s.default_browser_check == "hide":
        out["DontCheckDefaultBrowser"] = True
    out.update(s.extra)
    return out


def _firefox_extension(entry: str) -> tuple[str, str]:
    """An extension as the console names it: an add-on id with an install
    address, `uBlock0@raymondhill.net=https://…/latest.xpi`, or just the
    add-on's slug on addons.mozilla.org, `ublock-origin`, in which case the id
    has to be the slug too (which is only right for some). Explicit is
    better: the console's hint says so."""
    if "=" in entry:
        identifier, url = entry.split("=", 1)
        return identifier.strip(), url.strip()
    slug = entry.strip()
    return slug, f"https://addons.mozilla.org/firefox/downloads/latest/{slug}/latest.xpi"


def chromium(s: BrowserSettings) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if s.homepage:
        out["HomepageLocation"] = s.homepage
        out["HomepageIsNewTabPage"] = False
        out["ShowHomeButton"] = True
    if s.start_page == "homepage" and s.homepage:
        out["RestoreOnStartup"] = 4
        out["RestoreOnStartupURLs"] = [s.homepage]
    elif s.start_page == "previous-session":
        out["RestoreOnStartup"] = 1
    elif s.start_page == "new-tab":
        out["RestoreOnStartup"] = 5
    if s.bookmarks:
        out["ManagedBookmarks"] = [{"toplevel_name": s.bookmarks_folder or "Bookmarks"}] + [
            {"name": entry.name, "url": entry.url} for entry in s.bookmarks
        ]
    if s.bookmarks_bar != "unset":
        out["BookmarkBarEnabled"] = s.bookmarks_bar == "always"
    if s.extensions_install:
        out["ExtensionInstallForcelist"] = [
            _chromium_extension(entry) for entry in s.extensions_install
        ]
    blocklist = list(s.extensions_block)
    if s.extensions_user_install == "block":
        blocklist.append("*")
    if blocklist:
        out["ExtensionInstallBlocklist"] = blocklist
        if s.extensions_install:
            out["ExtensionInstallAllowlist"] = [
                _chromium_extension(entry).split(";")[0] for entry in s.extensions_install
            ]
    if (value := _tristate(s.password_manager)) is not None:
        out["PasswordManagerEnabled"] = value
    if (value := _tristate(s.autofill)) is not None:
        out["AutofillAddressEnabled"] = value
        out["AutofillCreditCardEnabled"] = value
    if s.history == "clear-on-exit":
        out["ClearBrowsingDataOnExitList"] = [
            "browsing_history", "download_history", "cookies_and_other_site_data",
            "cached_images_and_files", "autofill",
        ]
    elif s.history == "disabled":
        out["SavingBrowserHistoryDisabled"] = True
    if (value := _tristate(s.private_browsing)) is not None:
        out["IncognitoModeAvailability"] = 0 if value else 1
    if (value := _tristate(s.developer_tools)) is not None:
        out["DeveloperToolsAvailability"] = 1 if value else 2
    if (value := _tristate(s.telemetry)) is not None:
        out["MetricsReportingEnabled"] = value
    if (value := _tristate(s.sync_accounts)) is not None:
        out["BrowserSignin"] = 1 if value else 0
        out["SyncDisabled"] = not value
    if (value := _tristate(s.popups)) is not None:
        out["DefaultPopupsSetting"] = 1 if value else 2
    if s.default_search:
        out["DefaultSearchProviderEnabled"] = True
        out["DefaultSearchProviderName"] = s.default_search
        if s.default_search_url:
            out["DefaultSearchProviderSearchURL"] = s.default_search_url.replace(
                "{searchTerms}", "{searchTerms}"
            )
    if s.download_directory:
        out["DownloadDirectory"] = s.download_directory
        out["PromptForDownloadLocation"] = False
    if s.proxy_mode != "unset":
        out["ProxyMode"] = {
            "system": "system", "none": "direct", "manual": "fixed_servers", "pac": "pac_script",
        }[s.proxy_mode]
        if s.proxy_mode == "manual" and s.proxy_server:
            out["ProxyServer"] = s.proxy_server
        if s.proxy_mode == "pac" and s.proxy_pac_url:
            out["ProxyPacUrl"] = s.proxy_pac_url
        if s.proxy_bypass:
            out["ProxyBypassList"] = ",".join(s.proxy_bypass)
    if s.blocked_sites:
        out["URLBlocklist"] = list(s.blocked_sites)
    if s.allowed_sites:
        out["URLAllowlist"] = list(s.allowed_sites)
    if s.first_run_pages == "hide":
        out["PromotionalTabsEnabled"] = False
    if s.default_browser_check == "hide":
        out["DefaultBrowserSettingEnabled"] = False
    out.update(s.extra)
    return out


def _chromium_extension(entry: str) -> str:
    """A Web Store id, or `id;update-url` for one hosted elsewhere."""
    if ";" in entry:
        return entry.strip()
    return f"{entry.strip()};https://clients2.google.com/service/update2/crx"


def fold(settings: dict[str, Any]) -> None:
    """Turn the typed settings in a merged document into native browser
    policy, on top of whatever an ADMX template already produced."""
    browser = settings.get("browser") or {}
    changed = False
    for key, translate in (("firefox_policy", firefox), ("chromium_policy", chromium)):
        raw = settings.pop(key, None)
        if not raw:
            continue
        typed = BrowserSettings.model_validate(raw)
        native = translate(typed)
        if not native:
            continue
        name = key.split("_", 1)[0]
        browser[name] = {**browser.get(name, {}), **native}
        changed = True
    if changed:
        settings["browser"] = browser
