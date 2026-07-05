# 2026-07-05 — Profile Right-Click Open in New Tab

## Summary

Implemented popup profile-card right-click menu for opening the current page in a selected profile session.

## Changes

- Added `src/popup/popup-open-in-tab-menu.ts` for custom right-click and keyboard context-menu handling.
- Threaded current tab URL through profile-list rendering so the menu can call `createSessionTab`.
- Hardened `createSessionTab` to reject unknown profile ids before creating tabs.
- Tightened popup URL gating to match the background `http(s)` contract.
- Added unit and e2e coverage for invalid ids, default-cookie absence, keyboard menu access, and two tabs sharing the selected profile session.

## Verification

- `npm run type-check`
- `npm run test:unit`
- `npm run test:e2e`

## Unresolved Questions

None.
