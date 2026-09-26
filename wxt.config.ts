import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'Syncwarden',
    description: 'Syncs your browser bookmarks with a self-hosted Linkwarden, with dry run, deletion guard and snapshots.',
    permissions: [
      'bookmarks',
      'storage',
      'unlimitedStorage',
      'alarms',
      'notifications',
      'activeTab',
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // Toolbar button icon; WXT only fills the top-level "icons" on its own.
    action: {
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
      },
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'syncwarden@ariazonaa',
              // 140: first release with built-in data collection consent.
              strict_min_version: '140.0',
              // Bookmarks go to the user's own Linkwarden; "save current page"
              // sends the page URL there. Mozilla counts both as transmission.
              data_collection_permissions: {
                required: ['bookmarksInfo', 'browsingActivity'],
              },
            },
            // Android isn't supported (AMO compatibility is desktop only).
            // This only states that data_collection_permissions needs 142
            // there, which silences the AMO validator warning.
            gecko_android: {
              strict_min_version: '142.0',
            },
          },
        }
      : {}),
  }),
  zip: {
    // The sources zip goes to Mozilla for review. Only what builds the
    // extension; tools/ and publish/ are private maintainer scripts.
    excludeSources: ['tools/**', 'publish/**', 'docs/**', 'design/**'],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
