"""custom_packages against real .deb files, built on the fly with dpkg-deb —
the same tool that reads them back, so a change to how one is inspected is
caught here rather than only against a hand-typed fixture."""

from __future__ import annotations

import subprocess

import pytest

from odm import custom_packages
from odm.config import Settings


def build_deb(tmp_path, *, name="odm-test-package", version="1.2.3", arch="all") -> bytes:
    root = tmp_path / "pkgroot"
    (root / "DEBIAN").mkdir(parents=True)
    (root / "DEBIAN" / "control").write_text(
        f"Package: {name}\n"
        f"Version: {version}\n"
        f"Architecture: {arch}\n"
        "Maintainer: Open Directory Manager Contributors <hello@example.org>\n"
        "Description: a test fixture, not real software\n"
    )
    out = tmp_path / "out.deb"
    subprocess.run(  # noqa: S603, S607 - fixed argv, a real Debian tool, test-only
        ["/usr/bin/dpkg-deb", "--build", "--root-owner-group", str(root), str(out)],
        check=True, capture_output=True,
    )
    return out.read_bytes()


def settings_with(tmp_path) -> Settings:
    return Settings(
        realm="corp.example.internal",
        domain="corp.example.internal",
        ldap_uri="ldaps://dc1",
        ldap_ca_cert="/nonexistent",
        database_url="postgresql://odm@localhost/odm",
        custom_package_dir=tmp_path / "packages",
    )


def test_a_real_deb_is_inspected_correctly(tmp_path):
    content = build_deb(tmp_path, name="odm-test-package", version="2.0.1", arch="amd64")
    settings = settings_with(tmp_path)

    package_id, name, version, arch = custom_packages.save(settings, content, "test.deb")

    assert name == "odm-test-package"
    assert version == "2.0.1"
    assert arch == "amd64"
    assert custom_packages.path_for(settings, package_id).read_bytes() == content


def test_something_that_is_not_a_deb_at_all_is_refused(tmp_path):
    settings = settings_with(tmp_path)
    with pytest.raises(custom_packages.CustomPackageError):
        custom_packages.save(settings, b"not a package, just some bytes", "fake.deb")
    # And nothing was left behind for the failed upload.
    assert list(settings.custom_package_dir.glob("*.deb")) == []


def test_an_empty_upload_is_refused(tmp_path):
    settings = settings_with(tmp_path)
    with pytest.raises(custom_packages.CustomPackageError):
        custom_packages.save(settings, b"", "empty.deb")


def test_an_oversized_upload_is_refused_before_touching_dpkg_deb(tmp_path, monkeypatch):
    settings = settings_with(tmp_path)
    monkeypatch.setattr(custom_packages, "MAX_BYTES", 10)
    with pytest.raises(custom_packages.CustomPackageError, match="MB"):
        custom_packages.save(settings, b"x" * 100, "big.deb")


def test_delete_removes_the_file(tmp_path):
    settings = settings_with(tmp_path)
    content = build_deb(tmp_path)
    package_id, *_ = custom_packages.save(settings, content, "test.deb")
    assert custom_packages.path_for(settings, package_id).exists()

    custom_packages.delete(settings, package_id)

    assert not custom_packages.path_for(settings, package_id).exists()
    # Deleting one that was never there, or already gone, is not an error.
    custom_packages.delete(settings, package_id)
