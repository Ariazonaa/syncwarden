# Changelog

## 0.1.1 (2026-09-26)

### Added

- **Firefox support** (desktop, version 140 or newer). The Firefox build is
  submitted to addons.mozilla.org and is waiting for Mozilla's review.
  - Firefox's Bookmarks Menu is synced like Other Bookmarks, as collections
    under `Bookmarks Menu/…`. New entries from Linkwarden still land in the
    bookmarks toolbar.
  - Separators are skipped when syncing and restored as separators from a
    snapshot.
- **The access token is encrypted at rest.** It is encrypted with a device key
  that the browser won't let anyone export, including the extension itself. A
  plaintext token from 0.1.0 is encrypted automatically the first time it is
  read. The browser may keep the old plaintext value in its storage files for
  a while, so create a fresh token in Linkwarden after updating if you want to
  be sure.

### Changed

- **Root folders are recognized by the browser's own markers**, not by their
  position. Chromium uses `folderType`, Firefox fixed root ids. From Chromium
  134 on, enterprise (managed) bookmark folders are never treated as a sync
  root.
- **Snapshot restore matches root folders by kind**, not by position or
  localized name. Changing the browser language no longer blocks a restore.
- **Host access is requested for your Linkwarden host without the port**, so
  it covers every port on that host. If you update from 0.1.0, the next "Test
  connection" asks once for this access.

### Fixed

- **A Linkwarden instance on a non-default port** (e.g. `:3000`) couldn't be
  reached in Firefox.
- **Renaming a link in Linkwarden moved its bookmark.** A bookmark in Other
  Bookmarks, Mobile Bookmarks or the Firefox Bookmarks Menu ended up in the
  bookmarks bar. It now stays in its folder unless its collection actually
  changed.

## 0.1.0 (2026-09-25)

First public release, Chromium only.
