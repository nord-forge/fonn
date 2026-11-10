// Entry point for both pages. Each module enhances markup that is already
// readable without JavaScript.
import { setupCopyButtons } from './copy.js';
import { setupDock } from './dock.js';
import { setupTabs } from './tabs.js';
import { setupToc } from './toc.js';

setupTabs();
setupCopyButtons();
setupToc();
setupDock();
