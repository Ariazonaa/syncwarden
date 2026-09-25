import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
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
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
