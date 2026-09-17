"""Typed browser settings become each browser's own managed policy."""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)

from odm import browserpolicy
from odm.policy_schema import BrowserSettings


def test_a_start_page_and_bookmarks_reach_both_browsers_in_their_own_words():
    typed = BrowserSettings(
        start_page="homepage",
        homepage="https://intranet.corp.example.internal/",
        bookmarks_folder="Example Corp",
        bookmarks=[{"name": "Tickets", "url": "https://tickets.corp.example.internal/"}],
        bookmarks_bar="always",
        password_manager="block",
        private_browsing="block",
        history="clear-on-exit",
        extensions_install=["uBlock0@raymondhill.net=https://x.example/ublock.xpi"],
        extensions_user_install="block",
        proxy_mode="manual",
        proxy_server="proxy.corp.example.internal:3128",
        proxy_bypass=["*.corp.example.internal"],
    )
    ff = browserpolicy.firefox(typed)
    assert ff["Homepage"] == {
        "URL": "https://intranet.corp.example.internal/", "Locked": True, "StartPage": "homepage",
    }
    assert ff["ManagedBookmarks"][0] == {"toplevel_name": "Example Corp"}
    assert ff["DisplayBookmarksToolbar"] == "always"
    assert ff["PasswordManagerEnabled"] is False
    assert ff["DisablePrivateBrowsing"] is True
    assert ff["SanitizeOnShutdown"]["History"] is True
    ublock = ff["ExtensionSettings"]["uBlock0@raymondhill.net"]
    assert ublock["installation_mode"] == "force_installed"
    assert ff["ExtensionSettings"]["*"]["installation_mode"] == "blocked"
    assert ff["Proxy"]["Mode"] == "manual" and ff["Proxy"]["HTTPProxy"].endswith(":3128")

    ch = browserpolicy.chromium(typed)
    assert ch["RestoreOnStartup"] == 4 and ch["RestoreOnStartupURLs"] == [typed.homepage]
    assert ch["BookmarkBarEnabled"] is True
    assert ch["PasswordManagerEnabled"] is False
    assert ch["IncognitoModeAvailability"] == 1
    assert "browsing_history" in ch["ClearBrowsingDataOnExitList"]
    assert ch["ExtensionInstallBlocklist"] == ["*"]
    assert ch["ProxyMode"] == "fixed_servers" and ch["ProxyBypassList"] == "*.corp.example.internal"


def test_unset_means_the_browser_is_left_alone():
    assert browserpolicy.firefox(BrowserSettings()) == {}
    assert browserpolicy.chromium(BrowserSettings()) == {}


def test_typed_settings_fold_over_what_a_template_produced():
    settings = {
        "browser": {
            "firefox": {"DisableTelemetry": False, "Cookies": {"Behavior": "reject-tracker"}}
        },
        "firefox_policy": {"telemetry": "block"},
        "chromium_policy": {
            "developer_tools": "block", "extra": {"HttpsOnlyMode": "force_enabled"}
        },
    }
    browserpolicy.fold(settings)
    assert "firefox_policy" not in settings and "chromium_policy" not in settings
    firefox = settings["browser"]["firefox"]
    assert firefox["DisableTelemetry"] is True, "the typed setting wins"
    assert firefox["Cookies"] == {"Behavior": "reject-tracker"}, "the template's other policy stays"
    assert settings["browser"]["chromium"] == {
        "DeveloperToolsAvailability": 2, "HttpsOnlyMode": "force_enabled",
    }


def test_the_password_manager_extension_is_installed_and_pointed_at_the_vault():
    settings = {
        "browser": {
            "firefox": {"ExtensionSettings": {"other@example": {"installation_mode": "allowed"}}}
        },
        "password_manager": {"firefox": True, "chromium": True, "desktop_app": True},
    }
    browserpolicy.fold(
        settings, "https://vault.corp.example.internal", "https://odm.corp.example.internal:8443"
    )
    firefox = settings["browser"]["firefox"]
    assert firefox["ExtensionSettings"]["other@example"] == {"installation_mode": "allowed"}
    bitwarden = firefox["ExtensionSettings"][browserpolicy.BITWARDEN_FIREFOX_ID]
    assert bitwarden["installation_mode"] == "force_installed"
    assert firefox["3rdparty"]["Extensions"][browserpolicy.BITWARDEN_FIREFOX_ID] == {
        "environment": {"base": "https://vault.corp.example.internal"}
    }
    assert firefox["PasswordManagerEnabled"] is False
    assert firefox["Authentication"] == {"SPNEGO": ["odm.corp.example.internal"]}
    chromium = settings["browser"]["chromium"]
    assert chromium["AuthServerAllowlist"] == "odm.corp.example.internal"
    assert chromium["ExtensionInstallForcelist"][0].startswith(browserpolicy.BITWARDEN_CHROME_ID)
    managed = chromium["3rdparty"]["extensions"][browserpolicy.BITWARDEN_CHROME_ID]
    assert managed["environment"]["base"]
    # What the agent gets: the resolved vault, and whether the desktop app is wanted.
    assert settings["password_manager"] == {
        "vault_url": "https://vault.corp.example.internal", "desktop_app": True,
    }

    # No vault yet: nothing to point at, so nothing is written.
    plain = {"password_manager": {"browser_extension": True}}
    browserpolicy.fold(plain, "")
    assert "browser" not in plain
    assert plain["password_manager"] == {"vault_url": "", "desktop_app": False}
